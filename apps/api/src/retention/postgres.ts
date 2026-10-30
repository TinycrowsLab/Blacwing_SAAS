import { eq, sql } from 'drizzle-orm';

import { RETENTION_DATA_CLASSES, RETENTION_DEFAULTS } from '@blackwing/contracts';
import {
  retentionPolicies,
  tenants,
  withTenant,
  type Database,
  type TenantTx,
} from '@blackwing/db';

import type {
  RetentionAuditRecord,
  RetentionPolicyWrite,
  RetentionStore,
  RetentionTx,
  StoredRetentionPolicy,
} from './ports.js';

/**
 * Writes one audit event inside the caller's transaction. Supplied by the ledger's owner (AUDIT-002):
 * the event must commit with the policy change or not at all (§8.8).
 */
export type RetentionAuditWriter = (tx: TenantTx, record: RetentionAuditRecord) => Promise<void>;

/**
 * Inserts the platform default row of every class the tenant does not have yet (RETAIN-001: defaults
 * are seeded for a new tenant). Idempotent: an existing row is left as it is. Runs inside the tenant's
 * transaction, so RLS confines it to that tenant.
 */
export async function seedRetentionDefaults(tx: TenantTx, tenantId: string): Promise<void> {
  await tx
    .insert(retentionPolicies)
    .values(
      RETENTION_DATA_CLASSES.map((dataClass) => ({
        tenantId,
        dataClass,
        retentionDays: RETENTION_DEFAULTS[dataClass].retentionDays,
        minRetentionDays: RETENTION_DEFAULTS[dataClass].minRetentionDays,
        enabled: true,
        legalHoldOverrides: false,
      })),
    )
    .onConflictDoNothing({ target: [retentionPolicies.tenantId, retentionPolicies.dataClass] });
}

/**
 * The Postgres `RetentionStore` (RETAIN-001). Every call runs through `withTenant`, so a missing tenant
 * fails closed and RLS confines each statement. Writes lock the tenant row first, so two `PUT`s for one
 * tenant run one after the other and the loser's `If-Match` check sees the winner's write.
 */
export function createPostgresRetentionStore(deps: {
  readonly db: Database;
  readonly appendAudit: RetentionAuditWriter;
}): RetentionStore {
  const { db, appendAudit } = deps;
  return {
    read: (tenantId) =>
      withTenant(db, tenantId, async (tx) => {
        await seedRetentionDefaults(tx, tenantId);
        return loadRows(tx, tenantId);
      }),
    transact: (tenantId, fn) =>
      withTenant(db, tenantId, (tx) => fn(retentionTxOf(tx, tenantId, appendAudit))),
  };
}

function retentionTxOf(
  tx: TenantTx,
  tenantId: string,
  appendAudit: RetentionAuditWriter,
): RetentionTx {
  return {
    async lockAndLoad() {
      await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      await seedRetentionDefaults(tx, tenantId);
      return loadRows(tx, tenantId);
    },
    async upsert(writes: readonly RetentionPolicyWrite[]) {
      if (writes.length === 0) return;
      await tx
        .insert(retentionPolicies)
        .values(
          writes.map((write) => ({
            tenantId: write.tenantId,
            dataClass: write.dataClass,
            retentionDays: write.retentionDays,
            minRetentionDays: write.minRetentionDays,
            enabled: write.enabled,
            legalHoldOverrides: false,
          })),
        )
        .onConflictDoUpdate({
          target: [retentionPolicies.tenantId, retentionPolicies.dataClass],
          set: {
            retentionDays: sql`excluded.retention_days`,
            minRetentionDays: sql`excluded.min_retention_days`,
            enabled: sql`excluded.enabled`,
            updatedAt: sql`now()`,
          },
        });
    },
    appendAudit: (record) => appendAudit(tx, record),
  };
}

async function loadRows(tx: TenantTx, tenantId: string): Promise<StoredRetentionPolicy[]> {
  const rows = await tx
    .select()
    .from(retentionPolicies)
    .where(eq(retentionPolicies.tenantId, tenantId));
  return rows.map((row) => ({
    tenantId: row.tenantId,
    dataClass: row.dataClass,
    retentionDays: row.retentionDays,
    minRetentionDays: row.minRetentionDays,
    enabled: row.enabled,
    legalHoldOverrides: row.legalHoldOverrides,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
