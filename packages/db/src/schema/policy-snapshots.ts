import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { idColumn, tenantIdColumn, tenantIdIndex } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';

/**
 * Signed policy snapshots (POLICY-007, CONTEXT_PACK §3.1, §8.2, §8.9). One row per snapshot of a tenant's effective
 * policy set, written only after the signed bundle is stored. The bundle itself lives in object storage under
 * `object_key`; this row pins its id (the SHA-256 of the canonical body), the Transit key version that signed it and
 * the policy versions it covers. Rows are immutable: the runtime role gets SELECT and INSERT only. The forward-only
 * migration in `migrations/` is generated from this file (`pnpm db:generate`) and then reviewed; FORCE ROW LEVEL
 * SECURITY and the grants are appended by hand because Drizzle does not model them.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const policySnapshots = pgTable(
  'policy_snapshots',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    /** Lowercase hex SHA-256 of the canonical snapshot body: the snapshot id (§8.9). */
    snapshotSha256: text('snapshot_sha256').notNull(),
    /** `<keyName>:v<N>`: the Transit version whose signature the bundle carries. */
    signingKeyId: text('signing_key_id').notNull(),
    baselineVersion: text('baseline_version').notNull(),
    /** The active tenant policy version covered; null when the snapshot is the baseline alone. */
    tenantPolicyVersion: integer('tenant_policy_version'),
    /** `t/<tenantId>/policy-snapshots/<snapshotSha256>.jws`: the tenant-prefixed key of the signed bundle. */
    objectKey: text('object_key').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    tenantIdIndex('policy_snapshots', t.tenantId),
    index('policy_snapshots_tenant_created_idx').on(t.tenantId, t.createdAt),
    unique('policy_snapshots_tenant_sha256_key').on(t.tenantId, t.snapshotSha256),
    check('policy_snapshots_sha256_check', sql`${t.snapshotSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'policy_snapshots_tenant_policy_version_check',
      sql`${t.tenantPolicyVersion} IS NULL OR ${t.tenantPolicyVersion} >= 1`,
    ),
    // The object key must sit under this tenant's prefix, so a row can never point at another tenant's bundle.
    check(
      'policy_snapshots_object_key_check',
      sql`${t.objectKey} LIKE ('t/' || ${t.tenantId}::text || '/policy-snapshots/%')`,
    ),
    pgPolicy('policy_snapshots_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type PolicySnapshotRow = typeof policySnapshots.$inferSelect;
export type NewPolicySnapshotRow = typeof policySnapshots.$inferInsert;
