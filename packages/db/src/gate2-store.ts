// The Drizzle side of the Gate 2 persistence (GATE2-001): one small, dumb query per method, all in the
// CALLER'S transaction. The rules (state machine, SoD, default deny, audit, idempotency) live in
// `gate2.ts`; the database re-enforces the invariants with checks and triggers (migration
// `gate2_exceptions`), so nothing here is the only line of defence.

import { and, eq, sql } from 'drizzle-orm';

import { activeTenantId } from './outbox.js';
import {
  gate2Exceptions,
  gateDecisions,
  type Gate2ExceptionRow,
  type NewGate2ExceptionRow,
  type NewGateDecisionRow,
} from './schema/gate2.js';

import type { TenantTx } from './with-tenant.js';

import type { Gate2EventType, Gate2State } from '@blackwing/domain';

/** The accepted change of one transition, as the machine computed it. */
export interface Gate2Transition {
  readonly id: string;
  /** The `state_version` the caller read; the write only lands on that exact version. */
  readonly fromVersion: number;
  readonly event: Gate2EventType;
  readonly to: Gate2State;
  readonly decidedBy: string | null;
}

/** What the service needs from the database. */
export interface Gate2Store {
  /** The transaction's tenant, or `TenantContextMissingError` (fail closed). */
  tenantId(): Promise<string>;
  /** The database clock: the only source of "now" for timeouts and decision instants. */
  now(): Promise<Date>;
  /** Inserts a new exception; `undefined` when `(tenant_id, idempotency_key)` already exists. */
  insertException(row: NewGate2ExceptionRow): Promise<Gate2ExceptionRow | undefined>;
  findByIdempotencyKey(key: string): Promise<Gate2ExceptionRow | undefined>;
  /** RLS confines this to the active tenant, so another tenant's id is "not found". */
  findById(id: string): Promise<Gate2ExceptionRow | undefined>;
  /**
   * Moves a `pending` exception at `fromVersion` to `to`, stamping `decided_at` from the database
   * clock. `undefined` when no such row matched: it was decided first, or the timing guard (an
   * approval before `timeout_at`, a timeout at or after it) did not hold.
   */
  transition(change: Gate2Transition): Promise<Gate2ExceptionRow | undefined>;
  insertDecision(row: NewGateDecisionRow): Promise<void>;
}

/** The Drizzle store over `tx`, the transaction `withTenant` hands to its callback. */
export function drizzleGate2Store(tx: TenantTx): Gate2Store {
  return {
    tenantId: () => activeTenantId(tx),

    async now() {
      const result = await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
      const value = result.rows[0]?.now;
      return value instanceof Date ? value : new Date(value ?? Number.NaN);
    },

    async insertException(row) {
      const [inserted] = await tx
        .insert(gate2Exceptions)
        .values(row)
        .onConflictDoNothing({ target: [gate2Exceptions.tenantId, gate2Exceptions.idempotencyKey] })
        .returning();
      return inserted;
    },

    async findByIdempotencyKey(key) {
      const [row] = await tx
        .select()
        .from(gate2Exceptions)
        .where(eq(gate2Exceptions.idempotencyKey, key))
        .limit(1);
      return row;
    },

    async findById(id) {
      const [row] = await tx
        .select()
        .from(gate2Exceptions)
        .where(eq(gate2Exceptions.id, id))
        .limit(1);
      return row;
    },

    async transition(change) {
      // The timing guard is part of the same statement as the state guard: an approval only lands
      // before `timeout_at` and a timeout only at or after it, by the database clock (F13).
      const timing =
        change.event === 'approve'
          ? sql`clock_timestamp() < ${gate2Exceptions.timeoutAt}`
          : change.event === 'time_out'
            ? sql`clock_timestamp() >= ${gate2Exceptions.timeoutAt}`
            : sql`true`;
      const [row] = await tx
        .update(gate2Exceptions)
        .set({
          state: change.to,
          stateVersion: change.fromVersion + 1,
          decidedBy: change.decidedBy,
          decidedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(gate2Exceptions.id, change.id),
            eq(gate2Exceptions.state, 'pending'),
            eq(gate2Exceptions.stateVersion, change.fromVersion),
            timing,
          ),
        )
        .returning();
      return row;
    },

    async insertDecision(row) {
      await tx.insert(gateDecisions).values(row);
    },
  };
}
