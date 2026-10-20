import pg from 'pg';

import { parseUuid, TenantId, type Uuid } from '@blackwing/ids';

/** The tenant context is missing or malformed. Raised before any query runs: fail closed (§7). */
export class TenantContextError extends Error {
  readonly code = 'TENANT_CONTEXT_REQUIRED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Normalises a tenant id to its UUIDv7 (`uuid` column value). Accepts the UUID itself or the public
 * `ten_…` id. Anything else (missing, empty, another entity's id) throws {@link TenantContextError}.
 */
export function tenantUuid(tenantId: unknown): Uuid {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new TenantContextError(
      'a tenant id is required: refusing to run without a tenant context',
    );
  }
  try {
    return tenantId.startsWith(`${TenantId.prefix}_`)
      ? TenantId.toUuid(tenantId)
      : parseUuid(tenantId);
  } catch {
    throw new TenantContextError(
      'the tenant id is not a UUIDv7 or a ten_ public id: refusing to run',
    );
  }
}

/** A pool, or a client checked out of one. */
export type Queryable = pg.Pool | pg.PoolClient;

/**
 * Runs `fn` in a transaction whose `app.tenant_id` is `tenantId`, mirroring the production RLS helper
 * (§7 `withTenant(tx, tenantId, fn)`): `BEGIN`, `SET LOCAL app.tenant_id` (via
 * `set_config(..., true)`, which takes a bind parameter), `fn`, then `COMMIT`, or `ROLLBACK` on any
 * error. The setting is transaction-local, so it never leaks to the next use of a pooled connection.
 *
 * Given a pool, a client is checked out and released afterwards (destroyed if the rollback failed).
 * Given a client, it must not already be inside a transaction.
 */
export async function withTenant<T>(
  db: Queryable,
  tenantId: string,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const uuid = tenantUuid(tenantId);
  const owned = db instanceof pg.Pool;
  const client = db instanceof pg.Pool ? await db.connect() : db;
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [uuid]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw error;
    }
  } finally {
    if (owned) client.release(broken);
  }
}
