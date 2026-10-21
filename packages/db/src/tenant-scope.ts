// The tenant data-access choke point (TENANT-002, CONTEXT_PACK §7, §8.6, §8.11). Three deterministic
// layers keep tenant tables behind `withTenant` (with-tenant.ts, the single implementation):
//   1. compile time: repositories take a `TenantScopedDb`, which only `withTenant` can produce;
//   2. lint time: the `blackwing/no-raw-tenant-db` rule (scripts/eslint-rules) rejects a raw `db`
//      or pool query against a table that carries `tenant_id`;
//   3. run time: `assertTenantScope` double-checks the transaction really holds a tenant context.
// RLS (DB-003) stays the last line of defence. See docs/architecture/tenant-data-access.md.

import { sql } from 'drizzle-orm';

import { TenantContextMissingError } from '@blackwing/errors';
import { createLogger, type Logger } from '@blackwing/logger';

import {
  type DbTxMetrics,
  hashTenant,
  TenantContextMismatchError,
  type TenantTx,
} from './with-tenant.js';

/**
 * The handle a tenant-scoped repository function accepts. It is `TenantTx`: a type-only brand that
 * is not exported as a value and that nothing but `withTenant` attaches, so a raw `Database`, a
 * pool or a `withSystem` handle is a compile error where a `TenantScopedDb` is required.
 */
export type TenantScopedDb = TenantTx;

/** Optional collaborators of {@link assertTenantScope}. */
export interface AssertTenantScopeOptions {
  /** Receives `tenantContextMissing()` when the fail-closed error fires (`bw_tenant_context_missing_total`). */
  readonly metrics?: Pick<DbTxMetrics, 'tenantContextMissing'>;
  readonly logger?: Pick<Logger, 'warn'>;
}

let defaultLogger: Logger | undefined;

/** Reads the transaction's `app.tenant_id` setting; `null` when it is unset or empty. */
async function readTenantSetting(tx: TenantScopedDb): Promise<string | null> {
  const result = await tx.execute(sql`SELECT current_setting('app.tenant_id', true) AS tenant_id`);
  const value = result.rows[0]?.tenant_id;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Defence in depth for repositories: confirms that `tx` holds a tenant context, and optionally that
 * it is `expectedTenantId`. It only reads `app.tenant_id`; it never sets or changes the context.
 *
 * - No context (unset or empty) throws `TenantContextMissingError` (`TENANT_CONTEXT_MISSING`).
 * - A different tenant throws `TenantContextMismatchError` (`TENANT_CONTEXT_CONFLICT`).
 * Messages never contain a tenant id; the log line carries only the short hash (§8.7).
 */
export async function assertTenantScope(
  tx: TenantScopedDb,
  expectedTenantId?: string,
  options: AssertTenantScopeOptions = {},
): Promise<void> {
  defaultLogger ??= createLogger('@blackwing/db');
  const logger = options.logger ?? defaultLogger;
  const current = await readTenantSetting(tx);
  if (current === null) {
    options.metrics?.tenantContextMissing();
    logger.warn({}, 'db.tenant_scope.missing');
    throw new TenantContextMissingError('transaction has no tenant context: refusing to continue', {
      reason: 'missing',
    });
  }
  if (expectedTenantId !== undefined && current.toLowerCase() !== expectedTenantId.toLowerCase()) {
    logger.warn({ tenantId: hashTenant(current.toLowerCase()) }, 'db.tenant_scope.mismatch');
    throw new TenantContextMismatchError('transaction tenant context is not the expected tenant');
  }
}
