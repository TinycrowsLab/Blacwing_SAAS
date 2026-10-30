import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  type PgTableExtraConfigValue,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  COVERAGE_JSON_MAX_BYTES,
  COVERAGE_OUTCOMES,
  INTRUSIVENESS_CLASSES,
} from '@blackwing/contracts';

import { idColumn, tenantIdColumn, tenantIdIndex, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';
import { coverageManifests } from './coverage-manifests.js';
import { testCases } from './test-plans.js';

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/**
 * One test case's row in a coverage manifest (COVERAGE-001, F19, CONTEXT_PACK §7). `(manifest_id, test_case_id)` is
 * unique: a case has one row per manifest, and a repeated record updates it while the manifest is `open`. The row
 * copies the case's identity (title, class, references, targets, roles) when it is recorded, so the coverage stays
 * readable after the case changes. The composite foreign keys keep both parents inside the same tenant.
 *
 * Tenant table: FORCE ROW LEVEL SECURITY, grants and the updated-at trigger are appended by hand in the migration.
 */
export const coverageEntries = pgTable(
  'coverage_entries',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    manifestId: uuid('manifest_id').notNull(),
    testCaseId: uuid('test_case_id').notNull(),
    title: text('title').notNull(),
    class: text('class', { enum: INTRUSIVENESS_CLASSES }).notNull(),
    owaspRefs: text('owasp_refs')
      .array()
      .notNull()
      .default(sql`'{}'`),
    wstgRefs: text('wstg_refs')
      .array()
      .notNull()
      .default(sql`'{}'`),
    cweCandidates: text('cwe_candidates')
      .array()
      .notNull()
      .default(sql`'{}'`),
    targets: jsonb('targets').$type<unknown[]>().notNull(),
    roles: text('roles')
      .array()
      .notNull()
      .default(sql`'{}'`),
    outcome: text('outcome', { enum: COVERAGE_OUTCOMES }).notNull(),
    /** Why the case was not executed. Null only for `executed`. */
    reason: text('reason'),
    /** The subtask that ran the case, when there is one. A plain id: subtasks are owned by another epic. */
    subtaskId: uuid('subtask_id'),
    /** Traffic the case used, as an object. */
    budgetUsed: jsonb('budget_used').$type<Record<string, unknown>>(),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantIdIndex('coverage_entries', t.tenantId),
    unique('coverage_entries_manifest_id_test_case_id_key').on(t.manifestId, t.testCaseId),
    index('coverage_entries_manifest_id_outcome_idx').on(t.manifestId, t.outcome),
    // A row can never name another tenant's manifest or case (RLS does not apply to FK checks).
    foreignKey({
      name: 'coverage_entries_manifest_fk',
      columns: [t.tenantId, t.manifestId],
      foreignColumns: [coverageManifests.tenantId, coverageManifests.id],
    }),
    foreignKey({
      name: 'coverage_entries_test_case_fk',
      columns: [t.tenantId, t.testCaseId],
      foreignColumns: [testCases.tenantId, testCases.id],
    }),
    check('coverage_entries_title_check', sql`length(${t.title}) >= 1`),
    check('coverage_entries_class_check', sql`${t.class} IN (${inList(INTRUSIVENESS_CLASSES)})`),
    check('coverage_entries_outcome_check', sql`${t.outcome} IN (${inList(COVERAGE_OUTCOMES)})`),
    // Every outcome except `executed` says why (the Zod schema is the first check, this is the backstop).
    check(
      'coverage_entries_reason_check',
      sql`(${t.outcome} = 'executed') = (${t.reason} IS NULL) AND (${t.reason} IS NULL OR length(${t.reason}) BETWEEN 1 AND 2000)`,
    ),
    check(
      'coverage_entries_targets_array_check',
      sql`jsonb_typeof(${t.targets}) = 'array' AND jsonb_array_length(${t.targets}) >= 1 AND octet_length(${t.targets}::text) <= ${sql.raw(String(COVERAGE_JSON_MAX_BYTES))}`,
    ),
    check(
      'coverage_entries_budget_used_check',
      sql`${t.budgetUsed} IS NULL OR (jsonb_typeof(${t.budgetUsed}) = 'object' AND octet_length(${t.budgetUsed}::text) <= ${sql.raw(String(COVERAGE_JSON_MAX_BYTES))})`,
    ),
    pgPolicy('coverage_entries_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type CoverageEntryRow = typeof coverageEntries.$inferSelect;
