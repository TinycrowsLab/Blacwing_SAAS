// Tenant-scoped persistence of Gate 2 decisions (CONTEXT_PACK §4.2, §4.3, F13, §8.8). Every statement runs
// through `withTenant`, so RLS confines it and a missing tenant fails closed. A decision is a compare-and-set
// from `pending`: a second decision, or a timeout after a human decision, changes nothing.

import { and, eq } from 'drizzle-orm';

import { type GateDecisionRow, gateDecisions } from './schema/gate-decisions.js';
import { withTenant } from './with-tenant.js';

import type { Database } from './client.js';

export type GateDecisionKind = 'tool_deferred' | 'scope_exception';
export type GateDecisionStatus = 'pending' | 'approved' | 'denied';

/** What the opener supplies for a new Gate 2 row. The gate is always 2 here. */
export interface OpenGate2Input {
  readonly decisionId: string;
  readonly runId: string;
  readonly kind: GateDecisionKind;
  /** Idempotency key: a second open with the same key (per tenant) returns the existing row. */
  readonly dedupeKey: string;
  readonly subtaskId: string | null;
  readonly sessionId: string | null;
  readonly toolUseId: string | null;
  readonly summary: string;
  readonly target: string | null;
  readonly requestedAt: Date;
  readonly timeoutAt: Date;
}

export interface Decide {
  readonly status: 'approved' | 'denied';
  /** The authenticated approver, or `null` when the system decided (timeout or cancellation). */
  readonly decidedBy: string | null;
  readonly decidedAt: Date;
  readonly reason: string;
  readonly auto: boolean;
}

export interface StoredGate2Decision {
  readonly decisionId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly kind: GateDecisionKind;
  readonly dedupeKey: string;
  readonly subtaskId: string | null;
  readonly sessionId: string | null;
  readonly toolUseId: string | null;
  readonly summary: string;
  readonly target: string | null;
  readonly status: GateDecisionStatus;
  readonly requestedAt: Date;
  readonly timeoutAt: Date;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly reason: string | null;
  readonly auto: boolean;
}

export interface PgGate2DecisionStore {
  /** Creates the pending row, or returns the existing one for the same `dedupeKey` (`created` says which). */
  open(
    tenantId: string,
    input: OpenGate2Input,
  ): Promise<{ readonly row: StoredGate2Decision; readonly created: boolean }>;
  get(tenantId: string, decisionId: string): Promise<StoredGate2Decision | null>;
  /** Compare-and-set from `pending`. `false` when the row was already decided (or does not exist). */
  decide(tenantId: string, decisionId: string, outcome: Decide): Promise<boolean>;
  listPending(tenantId: string, runId: string): Promise<readonly StoredGate2Decision[]>;
}

function toStored(row: GateDecisionRow): StoredGate2Decision {
  return {
    decisionId: row.decisionId,
    tenantId: row.tenantId,
    runId: row.runId,
    kind: row.kind as GateDecisionKind,
    dedupeKey: row.dedupeKey,
    subtaskId: row.subtaskId,
    sessionId: row.sessionId,
    toolUseId: row.toolUseId,
    summary: row.summary,
    target: row.target,
    status: row.status as GateDecisionStatus,
    requestedAt: row.requestedAt,
    timeoutAt: row.timeoutAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    reason: row.reason,
    auto: row.auto,
  };
}

export function createPgGate2DecisionStore(db: Database): PgGate2DecisionStore {
  return {
    async open(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const inserted = await tx
          .insert(gateDecisions)
          .values({ ...input, tenantId, gate: 2, status: 'pending' })
          .onConflictDoNothing({ target: [gateDecisions.tenantId, gateDecisions.dedupeKey] })
          .returning();
        const [created] = inserted;
        if (created !== undefined) return { row: toStored(created), created: true };
        const [existing] = await tx
          .select()
          .from(gateDecisions)
          .where(
            and(eq(gateDecisions.tenantId, tenantId), eq(gateDecisions.dedupeKey, input.dedupeKey)),
          )
          .limit(1);
        if (existing === undefined) throw new Error('gate decision conflict without a stored row');
        return { row: toStored(existing), created: false };
      });
    },

    async get(tenantId, decisionId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(gateDecisions)
          .where(eq(gateDecisions.decisionId, decisionId))
          .limit(1);
        return row === undefined ? null : toStored(row);
      });
    },

    async decide(tenantId, decisionId, outcome) {
      return withTenant(db, tenantId, async (tx) => {
        const updated = await tx
          .update(gateDecisions)
          .set({
            status: outcome.status,
            decidedBy: outcome.decidedBy,
            decidedAt: outcome.decidedAt,
            reason: outcome.reason,
            auto: outcome.auto,
          })
          .where(and(eq(gateDecisions.decisionId, decisionId), eq(gateDecisions.status, 'pending')))
          .returning({ decisionId: gateDecisions.decisionId });
        return updated.length === 1;
      });
    },

    async listPending(tenantId, runId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(gateDecisions)
          .where(
            and(
              eq(gateDecisions.tenantId, tenantId),
              eq(gateDecisions.runId, runId),
              eq(gateDecisions.status, 'pending'),
            ),
          )
          .orderBy(gateDecisions.requestedAt);
        return rows.map((row) => toStored(row));
      });
    },
  };
}
