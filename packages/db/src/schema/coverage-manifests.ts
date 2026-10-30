import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  jsonb,
  pgPolicy,
  pgTable,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { idColumn, tenantIdColumn, tenantIdIndex, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';
import { runs } from './runs.js';

/** Byte cap on the entries of one coverage manifest (`REPORT_MAX_TEST_CASES` entries stay well under it). */
const COVERAGE_ENTRIES_MAX_BYTES = 1_048_576;

/**
 * Coverage manifest of one run (F19, CONTEXT_PACK §7 `coverage_manifests`). One row per run. The report cannot be
 * exported without a finalised manifest (REPORT-006). Once `finalised_at` is set the row is immutable: a trigger
 * refuses every later update, and the runtime role has no DELETE.
 *
 * Tenant table: FORCE ROW LEVEL SECURITY, grants and the immutability trigger are appended by hand in the migration.
 */
export const coverageManifests = pgTable(
  'coverage_manifests',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    /** The run this manifest covers. The composite FK below keeps it inside the tenant. */
    runId: uuid('run_id').notNull(),
    /** Per test case: `{testCaseRef, status: tested | not_tested, reason}` (`coverageEntrySchema`). */
    entries: jsonb('entries')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Null while the manifest is still being built. Set once; the row never changes after that. */
    finalisedAt: timestamp('finalised_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    tenantIdIndex('coverage_manifests', t.tenantId),
    unique('coverage_manifests_tenant_id_run_id_key').on(t.tenantId, t.runId),
    foreignKey({
      name: 'coverage_manifests_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    check(
      'coverage_manifests_entries_check',
      sql`jsonb_typeof(${t.entries}) = 'array' AND octet_length(${t.entries}::text) <= ${sql.raw(String(COVERAGE_ENTRIES_MAX_BYTES))}`,
    ),
    pgPolicy('coverage_manifests_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type CoverageManifestRow = typeof coverageManifests.$inferSelect;
