import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { COVERAGE_JSON_MAX_BYTES, COVERAGE_MANIFEST_STATUSES } from '@blackwing/contracts';

import { idColumn, tenantIdColumn, tenantIdIndex, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';
import { runs } from './runs.js';

/** Byte cap on the entries of one coverage manifest (`REPORT_MAX_TEST_CASES` entries stay well under it). */
const COVERAGE_ENTRIES_MAX_BYTES = 1_048_576;

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/**
 * Coverage manifest of one run (F19, CONTEXT_PACK §7 `coverage_manifests`). One row per run, keyed by a `cov_`
 * public id. It is `open` while the run records test cases (`coverage_entries`) and `finalised` once it is complete:
 * `finalised_at` and `status` always agree, and a finalised row never changes again (a trigger refuses every later
 * update, and the runtime role has no DELETE). The report cannot be exported without a finalised manifest (REPORT-006).
 *
 * `entries` is the legacy per-case summary the report reads (`coverageEntrySchema`); the per-case rows of the coverage
 * model live in `coverage_entries`.
 *
 * Tenant table: FORCE ROW LEVEL SECURITY, grants and the immutability trigger are appended by hand in the migration.
 */
export const coverageManifests = pgTable(
  'coverage_manifests',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    /** The `cov_…` public id (`publicId('cov', id)`). Null only on rows created before COVERAGE-001. */
    publicId: text('public_id'),
    /** The run this manifest covers. The composite FK below keeps it inside the tenant. */
    runId: uuid('run_id').notNull(),
    status: text('status', { enum: COVERAGE_MANIFEST_STATUSES }).notNull().default('open'),
    /** Per test case: `{testCaseRef, status: tested | not_tested, reason}` (`coverageEntrySchema`). */
    entries: jsonb('entries')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The run's pins at finalisation (§8.9), as an object. Null while open. */
    pins: jsonb('pins').$type<Record<string, unknown>>(),
    /** SHA-256 over the finalised manifest (lowercase hex). Null while open. */
    sha256: text('sha256'),
    /** Counts by outcome, as an object. Null while open. */
    summary: jsonb('summary').$type<Record<string, unknown>>(),
    /** Null while the manifest is still being built. Set once; the row never changes after that. */
    finalisedAt: timestamp('finalised_at', { withTimezone: true, mode: 'date' }),
    /** The user who finalised the manifest. A user id only, no other PII. */
    finalisedBy: uuid('finalised_by'),
    ...timestamps(),
  },
  (t) => [
    tenantIdIndex('coverage_manifests', t.tenantId),
    unique('coverage_manifests_tenant_id_run_id_key').on(t.tenantId, t.runId),
    // Target of the composite foreign key from coverage_entries: an entry can never name another tenant's manifest.
    unique('coverage_manifests_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('coverage_manifests_public_id_key').on(t.publicId),
    foreignKey({
      name: 'coverage_manifests_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    check(
      'coverage_manifests_entries_check',
      sql`jsonb_typeof(${t.entries}) = 'array' AND octet_length(${t.entries}::text) <= ${sql.raw(String(COVERAGE_ENTRIES_MAX_BYTES))}`,
    ),
    check(
      'coverage_manifests_public_id_check',
      sql`${t.publicId} IS NULL OR starts_with(${t.publicId}, 'cov_')`,
    ),
    check(
      'coverage_manifests_status_check',
      sql`${t.status} IN (${inList(COVERAGE_MANIFEST_STATUSES)})`,
    ),
    // The status and the finalisation time say the same thing: finalised exactly when finalised_at is set.
    check(
      'coverage_manifests_status_finalised_at_check',
      sql`(${t.status} = 'finalised') = (${t.finalisedAt} IS NOT NULL)`,
    ),
    // A finalised manifest carries its pins, digest and summary; an open one carries none of them.
    check(
      'coverage_manifests_finalised_fields_check',
      sql`(${t.status} = 'finalised') = (${t.sha256} IS NOT NULL AND ${t.pins} IS NOT NULL AND ${t.summary} IS NOT NULL)`,
    ),
    check(
      'coverage_manifests_sha256_check',
      sql`${t.sha256} IS NULL OR ${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'coverage_manifests_pins_check',
      sql`${t.pins} IS NULL OR (jsonb_typeof(${t.pins}) = 'object' AND octet_length(${t.pins}::text) <= ${sql.raw(String(COVERAGE_JSON_MAX_BYTES))})`,
    ),
    check(
      'coverage_manifests_summary_check',
      sql`${t.summary} IS NULL OR (jsonb_typeof(${t.summary}) = 'object' AND octet_length(${t.summary}::text) <= ${sql.raw(String(COVERAGE_JSON_MAX_BYTES))})`,
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
