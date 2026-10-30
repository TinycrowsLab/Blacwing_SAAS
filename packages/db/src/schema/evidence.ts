import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { EVIDENCE_KINDS, EVIDENCE_OBJECT_BYTES_MAX, EVIDENCE_ROLES } from '@blackwing/contracts';

import { idColumn, tenantIdColumn, tenantIdIndex, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';
import { findingOccurrences, findings } from './findings.js';

/**
 * Evidence items (EVIDENCE, CONTEXT_PACK §7, §8.7, §8.8). An item is a reference to bytes in object storage: the
 * object key, the SHA-256 of those bytes and its place in the run's hash chain. The bytes never live in Postgres.
 *
 * The table is write-once. `bw_app` may SELECT and INSERT only (see the migration), so an item cannot be edited
 * or removed through the application, and the chain makes any edit outside it detectable. Legal hold and
 * retention are recorded here; the retention job reads them and never deletes a held item.
 */

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

const OBJECT_KEY_MAX_LENGTH = 512;
const CONTENT_TYPE_MAX_LENGTH = 120;

export const evidenceItems = pgTable(
  'evidence_items',
  {
    id: idColumn(),
    /** The `evd_…` public id of `id` (`publicId('evd', id)`). Null only on rows written before EVIDENCE-001. */
    publicId: text('public_id'),
    tenantId: tenantIdColumn(),
    /** The run whose evidence stream this item belongs to. Plain uuid until the `runs` table exists (ORCH). */
    runId: uuid('run_id').notNull(),
    /** The finding this item supports, once known. Null until a finding is linked (composite FK, see below). */
    findingId: uuid('finding_id'),
    /** The finding occurrence this item was captured for, when known (composite FK, see below). */
    occurrenceId: uuid('occurrence_id'),
    /** Position in the run's stream, from 1. `(tenant_id, run_id, sequence)` is unique. */
    sequence: integer('sequence').notNull(),
    kind: text('kind').notNull(),
    role: text('role').notNull(),
    /** Object-storage key. Always under the tenant's own prefix (`<tenantId>/...`), so S3 prefixes isolate tenants (§8.6). */
    objectKey: text('object_key').notNull(),
    /** Lowercase hex SHA-256 of the stored bytes. */
    sha256: text('sha256').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Chain link of the previous item in the stream; null for the first item only. */
    prevChain: text('prev_chain'),
    /** Chain link of this item (`evidenceChainLink`, @blackwing/crypto). */
    chain: text('chain').notNull(),
    retentionUntil: timestamp('retention_until', { withTimezone: true, mode: 'date' }),
    legalHold: boolean('legal_hold').notNull().default(false),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantIdIndex('evidence_items', t.tenantId),
    uniqueIndex('evidence_items_tenant_id_run_id_sequence_key').on(t.tenantId, t.runId, t.sequence),
    uniqueIndex('evidence_items_object_key_key').on(t.objectKey),
    uniqueIndex('evidence_items_public_id_key').on(t.publicId),
    // The finding-scoped lookup. A finding spans runs, so this is deliberately not unique: `sequence` is per run.
    index('evidence_items_finding_id_sequence_idx').on(t.findingId, t.sequence),
    // Composite FKs: plain FK checks bypass RLS, so a single-column reference could cross tenants.
    foreignKey({
      name: 'evidence_items_finding_fk',
      columns: [t.tenantId, t.findingId],
      foreignColumns: [findings.tenantId, findings.id],
    }),
    foreignKey({
      name: 'evidence_items_occurrence_fk',
      columns: [t.tenantId, t.occurrenceId],
      foreignColumns: [findingOccurrences.tenantId, findingOccurrences.id],
    }),
    check(
      'evidence_items_public_id_check',
      sql`${t.publicId} IS NULL OR ${t.publicId} ~ '^evd_[0-9abcdefghjkmnpqrstvwxyz]{26}$'`,
    ),
    check('evidence_items_sequence_check', sql`${t.sequence} >= 1`),
    // The first item of a stream has no previous link; every later one has exactly one.
    check('evidence_items_prev_chain_check', sql`(${t.sequence} = 1) = (${t.prevChain} IS NULL)`),
    check(
      'evidence_items_prev_chain_format_check',
      sql`${t.prevChain} IS NULL OR ${t.prevChain} ~ '^[0-9a-f]{64}$'`,
    ),
    check('evidence_items_chain_check', sql`${t.chain} ~ '^[0-9a-f]{64}$'`),
    check('evidence_items_kind_check', sql`${t.kind} IN (${inList(EVIDENCE_KINDS)})`),
    check('evidence_items_role_check', sql`${t.role} IN (${inList(EVIDENCE_ROLES)})`),
    check('evidence_items_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'evidence_items_size_check',
      sql`${t.size} >= 0 AND ${t.size} <= ${sql.raw(String(EVIDENCE_OBJECT_BYTES_MAX))}`,
    ),
    check(
      'evidence_items_content_type_check',
      sql`length(${t.contentType}) BETWEEN 1 AND ${sql.raw(String(CONTENT_TYPE_MAX_LENGTH))}`,
    ),
    check(
      'evidence_items_object_key_check',
      sql`length(${t.objectKey}) BETWEEN 1 AND ${sql.raw(String(OBJECT_KEY_MAX_LENGTH))} AND starts_with(${t.objectKey}, ${t.tenantId}::text || '/')`,
    ),
    pgPolicy('evidence_items_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

/**
 * Repro artifacts (EVIDENCE, CONTEXT_PACK §7): one reproduction bundle per finding. Like evidence items, the bundle
 * bytes live in object storage; this row holds the key, the SHA-256 and the bundle format version. Write-once.
 */
export const reproArtifacts = pgTable(
  'repro_artifacts',
  {
    id: idColumn(),
    /** The `rpa_…` public id of `id` (`publicId('rpa', id)`). */
    publicId: text('public_id').notNull(),
    tenantId: tenantIdColumn(),
    findingId: uuid('finding_id').notNull(),
    /** Object-storage key of the bundle. Under the tenant's own prefix, like `object_key`. */
    bundleKey: text('bundle_key').notNull(),
    /** Lowercase hex SHA-256 of the bundle bytes. */
    sha256: text('sha256').notNull(),
    /** Version of the bundle layout, so readers can refuse a format they do not know. */
    formatVersion: text('format_version').notNull(),
    size: bigint('size', { mode: 'number' }),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantIdIndex('repro_artifacts', t.tenantId),
    uniqueIndex('repro_artifacts_public_id_key').on(t.publicId),
    uniqueIndex('repro_artifacts_bundle_key_key').on(t.bundleKey),
    index('repro_artifacts_finding_id_idx').on(t.findingId),
    foreignKey({
      name: 'repro_artifacts_finding_fk',
      columns: [t.tenantId, t.findingId],
      foreignColumns: [findings.tenantId, findings.id],
    }),
    check(
      'repro_artifacts_public_id_check',
      sql`${t.publicId} ~ '^rpa_[0-9abcdefghjkmnpqrstvwxyz]{26}$'`,
    ),
    check(
      'repro_artifacts_bundle_key_check',
      sql`length(${t.bundleKey}) BETWEEN 1 AND ${sql.raw(String(OBJECT_KEY_MAX_LENGTH))} AND starts_with(${t.bundleKey}, ${t.tenantId}::text || '/')`,
    ),
    check('repro_artifacts_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('repro_artifacts_format_version_check', sql`length(${t.formatVersion}) BETWEEN 1 AND 32`),
    check(
      'repro_artifacts_size_check',
      sql`${t.size} IS NULL OR (${t.size} >= 0 AND ${t.size} <= ${sql.raw(String(EVIDENCE_OBJECT_BYTES_MAX))})`,
    ),
    pgPolicy('repro_artifacts_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);
