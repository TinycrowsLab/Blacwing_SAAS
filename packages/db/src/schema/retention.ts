import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgPolicy, pgTable, text, unique } from 'drizzle-orm/pg-core';

import { RETENTION_DATA_CLASSES, RETENTION_DAYS_MAX } from '@blackwing/contracts';

import { idColumn, tenantIdColumn, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';

/**
 * Per-tenant retention policies (RETAIN-001, CONTEXT_PACK §7, §8.6, §8.8). One row per tenant and data
 * class; a missing row means the platform default (`resolveRetention` in `@blackwing/domain`). The
 * forward-only migration in `migrations/` is generated from this file (`pnpm db:generate`), then the
 * FORCE ROW LEVEL SECURITY, grants and `updated_at` trigger are appended by hand (as for `secrets`).
 *
 * `legal_hold_overrides` is stored only to make the rule visible: the check constraint pins it to
 * `false`, so no row can ever let a sweep bypass legal hold or Object Lock.
 */

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/** Name of the unique index behind `(tenant_id, data_class)`, also the target of the upsert. */
export const RETENTION_POLICIES_CLASS_KEY = 'retention_policies_tenant_data_class_key';

export const retentionPolicies = pgTable(
  'retention_policies',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    dataClass: text('data_class', { enum: RETENTION_DATA_CLASSES }).notNull(),
    retentionDays: integer('retention_days').notNull(),
    /** The platform floor copied onto the row when it is written; the check below enforces it. */
    minRetentionDays: integer('min_retention_days').notNull(),
    /** Legal hold always wins: pinned to false by the check below. */
    legalHoldOverrides: boolean('legal_hold_overrides').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique(RETENTION_POLICIES_CLASS_KEY).on(t.tenantId, t.dataClass),
    check(
      'retention_policies_data_class_check',
      sql`${t.dataClass} IN (${inList(RETENTION_DATA_CLASSES)})`,
    ),
    check('retention_policies_min_check', sql`${t.minRetentionDays} >= 1`),
    check(
      'retention_policies_days_check',
      sql`${t.retentionDays} BETWEEN ${t.minRetentionDays} AND ${sql.raw(String(RETENTION_DAYS_MAX))}`,
    ),
    check('retention_policies_legal_hold_check', sql`${t.legalHoldOverrides} = false`),
    pgPolicy('retention_policies_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type RetentionPolicyRecord = typeof retentionPolicies.$inferSelect;
export type NewRetentionPolicyRecord = typeof retentionPolicies.$inferInsert;
