// The tenant-scoped transaction doorway (CONTEXT_PACK §7, §8.6): `BEGIN`, `set_config('app.tenant_id',
// $1, true)` (transaction-local), run the callback, `COMMIT`; any throw rolls back. A missing or
// malformed tenant id fails closed with `TenantContextMissingError` before a connection is used.
// OFFLINE-STUB note: this is the minimal form the repository pattern (DB-007) needs; the full helper
// (serialization-failure retry, `withSystem`, DB-scoped error codes) is owned by DB-006 (#73), which
// replaces the body of this file and keeps this signature.

import { sql } from 'drizzle-orm';

import { TenantContextMissingError } from '@blackwing/errors';

import { toTenantIsolationError } from './rls.js';

import type { Database, Tx } from './client.js';

/** The handle passed to a `withTenant` callback: a Drizzle transaction with `app.tenant_id` set. */
export type TenantTx = Tx;

const MAX_CAUSE_DEPTH = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs `fn` in a transaction scoped to `tenantId`; RLS then confines every statement to that tenant. */
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
    throw new TenantContextMissingError('a valid tenant id is required: refusing to run');
  }
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  } catch (error) {
    throw toTenantIsolationError(unwrapQueryError(error)) ?? error;
  }
}

/** Drizzle wraps driver errors in `DrizzleQueryError` with the pg error as `cause`. */
export function unwrapQueryError(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof (current as { code?: unknown } | null)?.code === 'string') return current;
    const cause = (current as { cause?: unknown } | null)?.cause;
    if (cause === undefined || cause === null) return error;
    current = cause;
  }
  return error;
}
