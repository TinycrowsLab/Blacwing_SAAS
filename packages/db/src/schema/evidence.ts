import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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
    tenantId: tenantIdColumn(),
    /** The run whose evidence stream this item belongs to. Plain uuid until the `runs` table exists (ORCH). */
    runId: uuid('run_id').notNull(),
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
