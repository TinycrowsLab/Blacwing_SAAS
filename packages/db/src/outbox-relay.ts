// The outbox relay's storage side (WORKFLOW-012, F12, F34, CONTEXT_PACK §7, §8.6, §8.8). The relay
// connects as the `bw_relay` login (a member of the NOLOGIN role of that name), the only role whose
// policies reach `outbox` rows across tenants: it can read them and update the delivery columns, and
// nothing else. `withOutboxClaim` claims a batch with `FOR UPDATE SKIP LOCKED` and keeps the claiming
// transaction open while the caller dispatches, so a row is only marked `dispatched` after its side
// effect ran: a crash in between rolls the claim back and the row is redelivered (at least once).
//
// Per-aggregate ordering: a row is only claimable while no EARLIER pending row of its aggregate exists
// (by `created_at`, ties by `id`), whether that row is backing off, locked by another relay or in this
// batch. So at most the head of each aggregate is in flight, and a later row never overtakes it.
// Every instant (`available_at`, `dispatched_at`, backoff) is the database clock: no pod clock is used.

import { sql } from 'drizzle-orm';

import type { Database, Tx } from './client.js';
import type { OutboxMessageType } from '@blackwing/contracts';

/** One claimed `pending` row, as the relay needs it. */
export interface ClaimedOutboxRow {
  readonly id: string;
  readonly tenantId: string;
  readonly type: OutboxMessageType;
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
  readonly payload: unknown;
  readonly dedupeKey: string | null;
  /** Failed deliveries so far (before the current attempt). */
  readonly attempts: number;
  readonly createdAt: Date;
}

/** The claimed rows and the only three ways to settle one of them, all inside the claiming transaction. */
export interface OutboxClaim {
  readonly rows: readonly ClaimedOutboxRow[];
  /** `status = 'dispatched'`, `dispatched_at = now()`. */
  markDispatched(id: string): Promise<void>;
  /** Failed attempt: `attempts + 1`, `last_error`, retry at `now() + delayMs`. */
  markRetry(id: string, error: string, delayMs: number): Promise<void>;
  /** Terminal: `attempts + 1`, `last_error`, `status = 'failed'`. */
  markFailed(id: string, error: string): Promise<void>;
}

interface ClaimRecord extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  type: OutboxMessageType;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: unknown;
  dedupe_key: string | null;
  attempts: number;
  created_at: Date;
}

const MAX_BATCH = 1_000;
const MS_PER_SECOND = 1_000;

/**
 * The relay's transaction-local tenant context. `outbox_tenant_isolation` applies to every role and
 * errors on an unset `app.tenant_id`, so the relay pins it to the nil UUID: that policy then matches
 * nothing, and the relay reaches rows only through its own policies (`outbox_relay_*`).
 */
const NIL_TENANT = '00000000-0000-0000-0000-000000000000';

/** Opens the relay transaction: pins the nil tenant and fails closed unless the session may act as `bw_relay`. */
async function enterRelayContext(tx: Tx): Promise<void> {
  const result = await tx.execute<{ ok: boolean }>(
    sql`SELECT pg_has_role(current_user, 'bw_relay', 'USAGE') AS ok,
               set_config('app.tenant_id', ${NIL_TENANT}, true)`,
  );
  if (result.rows[0]?.ok !== true) {
    throw new Error('the outbox relay must connect as a member of the bw_relay role');
  }
}

function requireCount(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  }
}

async function claimRows(tx: Tx, limit: number): Promise<ClaimedOutboxRow[]> {
  const result = await tx.execute<ClaimRecord>(sql`
    SELECT o.id, o.tenant_id, o.type, o.aggregate_type, o.aggregate_id, o.payload, o.dedupe_key,
           o.attempts, o.created_at
      FROM outbox o
     WHERE o.status = 'pending'
       AND o.available_at <= now()
       AND NOT EXISTS (
         SELECT 1 FROM outbox p
          WHERE p.aggregate_id = o.aggregate_id
            AND p.status = 'pending'
            AND (p.created_at, p.id) < (o.created_at, o.id))
     ORDER BY o.created_at, o.id
     LIMIT ${limit}
       FOR UPDATE OF o SKIP LOCKED`);
  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    dedupeKey: row.dedupe_key,
    attempts: row.attempts,
    createdAt: new Date(row.created_at),
  }));
}

/**
 * Claims up to `limit` due rows in one transaction on the relay pool and runs `fn` while holding
 * them. Commits when `fn` resolves, rolls everything back (every row stays `pending`) when it throws.
 * `db` must be a `bw_relay` connection; on the app role the call fails closed (no tenant context).
 */
export async function withOutboxClaim<T>(
  db: Database,
  limit: number,
  fn: (claim: OutboxClaim) => Promise<T>,
): Promise<T> {
  requireCount('limit', limit, MAX_BATCH);
  return await db.transaction(async (tx) => {
    await enterRelayContext(tx);
    const rows = await claimRows(tx, limit);
    return fn({
      rows,
      async markDispatched(id) {
        await tx.execute(sql`UPDATE outbox SET status = 'dispatched', dispatched_at = now(),
          last_error = NULL WHERE id = ${id} AND status = 'pending'`);
      },
      async markRetry(id, error, delayMs) {
        const seconds = Math.max(0, delayMs) / MS_PER_SECOND;
        await tx.execute(sql`UPDATE outbox SET attempts = attempts + 1, last_error = ${error},
          available_at = now() + make_interval(secs => ${seconds}::double precision) WHERE id = ${id} AND status = 'pending'`);
      },
      async markFailed(id, error) {
        await tx.execute(sql`UPDATE outbox SET attempts = attempts + 1, last_error = ${error},
          status = 'failed' WHERE id = ${id} AND status = 'pending'`);
      },
    });
  });
}

/** Pending rows per message type (`outbox_backlog{type}`), due or not. Reads across tenants: relay role only. */
export async function outboxBacklog(
  db: Database,
): Promise<Partial<Record<OutboxMessageType, number>>> {
  const result = await db.transaction(async (tx) => {
    await enterRelayContext(tx);
    return tx.execute<{ type: OutboxMessageType; count: string }>(
      sql`SELECT type, count(*)::text AS count FROM outbox WHERE status = 'pending' GROUP BY type`,
    );
  });
  const backlog: Partial<Record<OutboxMessageType, number>> = {};
  for (const row of result.rows) backlog[row.type] = Number(row.count);
  return backlog;
}
