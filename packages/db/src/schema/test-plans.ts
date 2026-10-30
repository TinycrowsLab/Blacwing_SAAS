import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  INTRUSIVENESS_CLASSES,
  TEST_CASE_STATUSES,
  TEST_CASE_STATUSES_WITH_REASON,
  TEST_PLAN_STATUSES,
} from '@blackwing/contracts';

import { idColumn, tenantIdColumn, tenantIdIndex, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';
import { runs } from './runs.js';

/**
 * Versioned test plans and their test cases (PLAN-001, CONTEXT_PACK §3.5, §7, §8.3, §8.6, §8.11). A plan
 * is one version of a run's plan; `(run_id, version)` is unique, so a concurrent writer that loses the race
 * gets a unique violation and retries with the next version. A case belongs to one plan version.
 *
 * Both tables are tenant tables: they carry the §7 policy from `TENANT_PREDICATE`, and composite
 * `(tenant_id, …)` foreign keys so a row can never reference another tenant's plan or run (plain FK checks
 * bypass RLS). The migration is generated from this file (`pnpm db:generate`) and then reviewed. FORCE ROW
 * LEVEL SECURITY and the grants are appended by hand because Drizzle does not model them.
 *
 * Size limits: `targets`, `budget`, `oracle` and `negative_control` are opaque jsonb. The API layer (PLAN-005)
 * caps each at 16 KiB; the CHECKs below are a 64 KiB backstop, so a bad writer fails closed.
 *
 * `destructive` is storable (provenance), but it can never be `approved`, `executing` or `executed` (CHECK,
 * §8.3). The repository also refuses to persist it in a planned plan.
 */

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/** Backstop for the opaque jsonb columns (bytes of their text form). The API layer enforces 16 KiB. */
const JSON_BACKSTOP_BYTES = 65_536;

/** Statuses a case may hold only once it runs or is approved to run (§8.3, §8.11). */
const RUNNING_CASE_STATUSES = ['approved', 'executing', 'executed'] as const;

export const testPlans = pgTable(
  'test_plans',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    runId: uuid('run_id').notNull(),
    /** Starts at 1 and increases by one per run (the repository assigns it, `(run_id, version)` is unique). */
    version: integer('version').notNull(),
    status: text('status', { enum: TEST_PLAN_STATUSES }).notNull().default('draft'),
    /** The user who created this version. A user id only, no other PII. */
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantIdIndex('test_plans', t.tenantId),
    index('test_plans_run_id_idx').on(t.runId),
    unique('test_plans_run_id_version_unique').on(t.runId, t.version),
    // Target of the composite foreign key from test_cases: a case can never name another tenant's plan.
    unique('test_plans_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'test_plans_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    check('test_plans_version_check', sql`${t.version} >= 1`),
    check('test_plans_status_check', sql`${t.status} IN (${inList(TEST_PLAN_STATUSES)})`),
    pgPolicy('test_plans_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export const testCases = pgTable(
  'test_cases',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    testPlanId: uuid('test_plan_id').notNull(),
    /** Intrusiveness class (F4). `destructive` is storable for provenance; the CHECKs below keep it from running. */
    class: text('class', { enum: INTRUSIVENESS_CLASSES }).notNull(),
    title: text('title').notNull(),
    owaspRefs: text('owasp_refs')
      .array()
      .notNull()
      .default(sql`'{}'`),
    wstgRefs: text('wstg_refs')
      .array()
      .notNull()
      .default(sql`'{}'`),
    asvsRefs: text('asvs_refs')
      .array()
      .notNull()
      .default(sql`'{}'`),
    cweCandidates: text('cwe_candidates')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** Target URLs or templates (a non-empty JSON array). */
    targets: jsonb('targets').$type<unknown[]>().notNull(),
    roles: text('roles')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** Per-case traffic budget `{maxRequests, maxRps, maxConcurrency, maxBytes}` (`testCaseBudgetSchema`). */
    budget: jsonb('budget').$type<Record<string, unknown>>().notNull(),
    /** The declared validation check, `{type, params}` (`oracleSchema`). Required before a case may run. */
    oracle: jsonb('oracle').$type<Record<string, unknown>>(),
    /** The declared negative control (`{type, params}`), or null. */
    negativeControl: jsonb('negative_control').$type<Record<string, unknown>>(),
    status: text('status', { enum: TEST_CASE_STATUSES }).notNull().default('proposed'),
    statusReason: text('status_reason'),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantIdIndex('test_cases', t.tenantId),
    index('test_cases_test_plan_id_idx').on(t.testPlanId),
    index('test_cases_status_idx').on(t.status),
    index('test_cases_class_idx').on(t.class),
    // Target of the composite foreign key from reversal_journal_entries (a journal entry names its own tenant's case).
    unique('test_cases_tenant_id_id_unique').on(t.tenantId, t.id),
    // Composite foreign key: a case must reference a plan of its own tenant (RLS does not apply to FK checks).
    foreignKey({
      name: 'test_cases_test_plan_fk',
      columns: [t.tenantId, t.testPlanId],
      foreignColumns: [testPlans.tenantId, testPlans.id],
    }),
    check('test_cases_class_check', sql`${t.class} IN (${inList(INTRUSIVENESS_CLASSES)})`),
    check('test_cases_status_check', sql`${t.status} IN (${inList(TEST_CASE_STATUSES)})`),
    check('test_cases_title_check', sql`length(${t.title}) >= 1`),
    check(
      'test_cases_targets_array_check',
      sql`jsonb_typeof(${t.targets}) = 'array' AND jsonb_array_length(${t.targets}) >= 1 AND octet_length(${t.targets}::text) <= ${sql.raw(String(JSON_BACKSTOP_BYTES))}`,
    ),
    check(
      'test_cases_budget_object_check',
      sql`jsonb_typeof(${t.budget}) = 'object' AND octet_length(${t.budget}::text) <= ${sql.raw(String(JSON_BACKSTOP_BYTES))}`,
    ),
    check(
      'test_cases_oracle_object_check',
      sql`${t.oracle} IS NULL OR (jsonb_typeof(${t.oracle}) = 'object' AND octet_length(${t.oracle}::text) <= ${sql.raw(String(JSON_BACKSTOP_BYTES))})`,
    ),
    check(
      'test_cases_negative_control_object_check',
      sql`${t.negativeControl} IS NULL OR (jsonb_typeof(${t.negativeControl}) = 'object' AND octet_length(${t.negativeControl}::text) <= ${sql.raw(String(JSON_BACKSTOP_BYTES))})`,
    ),
    // Statuses that carry a reason (`TEST_CASE_STATUSES_WITH_REASON`) must have one.
    check(
      'test_cases_status_reason_check',
      sql`${t.status} NOT IN (${inList(TEST_CASE_STATUSES_WITH_REASON)}) OR ${t.statusReason} IS NOT NULL`,
    ),
    // §8.3: a destructive case is never approved, executing or executed.
    check(
      'test_cases_destructive_never_runs_check',
      sql`${t.class} <> 'destructive' OR ${t.status} NOT IN (${inList(RUNNING_CASE_STATUSES)})`,
    ),
    // §8.11: a case that is approved, executing or executed has its declared oracle.
    check(
      'test_cases_oracle_required_check',
      sql`${t.status} NOT IN (${inList(RUNNING_CASE_STATUSES)}) OR ${t.oracle} IS NOT NULL`,
    ),
    pgPolicy('test_cases_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);
