import { z } from 'zod';

import { intrusivenessSchema } from './entities/authorisation.js';
import {
  oracleSchema,
  plannedTestCaseSchema,
  standardsRefsSchema,
  TEST_CASE_STATUSES,
  TEST_PLAN_STATUSES,
  testCaseBudgetSchema,
} from './entities/test-case.js';
import { uuidV7Schema } from './primitives.js';

/**
 * Editable test plan API contracts (PLAN-005, #395, CONTEXT_PACK §9). A run owns numbered plan versions.
 * A `draft` version is editable; once it is proposed, approved or superseded it is immutable and an edit
 * forks a new version (`PLAN_VERSION_IMMUTABLE`). Each `jsonb`-backed payload of a case is capped at
 * {@link TEST_PLAN_PAYLOAD_MAX_BYTES} (413 `PLAN_PAYLOAD_TOO_LARGE`).
 */

/** Ceiling for each jsonb payload of a test case (`targets`, `budget`, `oracle`, `negativeControl`). */
const BYTES_PER_KIB = 1024;
const PAYLOAD_CEILING_KIB = 8;
export const TEST_PLAN_PAYLOAD_MAX_BYTES = PAYLOAD_CEILING_KIB * BYTES_PER_KIB;

/** Page size of `GET /v1/runs/{runId}/test-plans` (§9): the default and the ceiling. */
export const TEST_PLAN_PAGE_DEFAULT = 50;
export const TEST_PLAN_PAGE_MAX = 200;
/** Longest cursor the list accepts. */
const CURSOR_MAX_LENGTH = 512;

/** `POST /v1/test-plans/{planId}/cases` body: a planned case (the planner's field set, `destructive` refused). */
export const testCaseCreateBodySchema = plannedTestCaseSchema;
export type TestCaseCreateBody = z.infer<typeof testCaseCreateBodySchema>;

/** `PATCH /v1/test-cases/{caseId}` body: at least one editable field. Unknown keys are refused. */
export const testCasePatchBodySchema = plannedTestCaseSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'at least one field must be provided',
  });
export type TestCasePatchBody = z.infer<typeof testCasePatchBodySchema>;

/** One test case as the API returns it. Removed cases stay visible with `status: removed`. */
export const testCaseViewSchema = z.strictObject({
  caseId: uuidV7Schema,
  planId: uuidV7Schema,
  class: intrusivenessSchema,
  title: z.string(),
  status: z.enum(TEST_CASE_STATUSES),
  statusReason: z.string().nullable(),
  refs: standardsRefsSchema,
  cweCandidates: z.array(z.string()),
  targets: z.array(z.string()),
  roles: z.array(z.string()),
  budget: testCaseBudgetSchema,
  oracle: oracleSchema.nullable(),
  negativeControl: oracleSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TestCaseView = z.infer<typeof testCaseViewSchema>;

/** A plan version without its cases (the list item). */
export const testPlanSummarySchema = z.strictObject({
  planId: uuidV7Schema,
  runId: uuidV7Schema,
  version: z.int().min(1),
  status: z.enum(TEST_PLAN_STATUSES),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TestPlanSummary = z.infer<typeof testPlanSummarySchema>;

/** A plan version with its cases. */
export const testPlanViewSchema = testPlanSummarySchema.extend({
  cases: z.array(testCaseViewSchema),
});
export type TestPlanView = z.infer<typeof testPlanViewSchema>;

/** `GET /v1/runs/{runId}/test-plans` page. `nextCursor` is null on the last page. */
export const testPlanPageSchema = z.strictObject({
  items: z.array(testPlanSummarySchema),
  nextCursor: z.string().nullable(),
});
export type TestPlanPage = z.infer<typeof testPlanPageSchema>;

/** `GET /v1/runs/{runId}/test-plans` query: keyset cursor and page size (§9, at most 200). */
export const testPlanListQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(TEST_PLAN_PAGE_MAX).default(TEST_PLAN_PAGE_DEFAULT),
});
export type TestPlanListQuery = z.output<typeof testPlanListQuerySchema>;

/**
 * The test case fields a plan diff compares (PLAN-002). Names follow the `test_cases` columns; the reference
 * arrays are named after their standard (`owasp_refs`, …) and `negative_control` after its column.
 */
export const PLAN_DIFF_FIELDS = [
  'class',
  'title',
  'status',
  'budget',
  'oracle',
  'negative_control',
  'targets',
  'roles',
  'owasp_refs',
  'wstg_refs',
  'asvs_refs',
  'cwe_candidates',
] as const;
const planDiffFieldSchema = z.enum(PLAN_DIFF_FIELDS);

/** A test case named by identity and title, for the added and removed lists. */
const testCaseRefSchema = z.strictObject({ caseId: uuidV7Schema, title: z.string() });
export type TestCaseRef = z.infer<typeof testCaseRefSchema>;

/** One field that differs: the canonical JSON value in each version (NFC strings, sorted object keys). */
export const planFieldChangeSchema = z.strictObject({
  field: planDiffFieldSchema,
  before: z.json(),
  after: z.json(),
});
export type PlanFieldChange = z.infer<typeof planFieldChangeSchema>;

/**
 * A case present in both versions with at least one differing field. `caseId` is its identity in the `from`
 * version (the case the approver saw before), `title` its title in the `to` version.
 */
export const modifiedCaseSchema = z.strictObject({
  caseId: uuidV7Schema,
  title: z.string(),
  changes: z.array(planFieldChangeSchema),
});
export type ModifiedCase = z.infer<typeof modifiedCaseSchema>;

/**
 * `GET /v1/runs/{runId}/test-plans/{version}/diff?against=` (PLAN-002): what changed from `against` (the
 * `fromVersion`) to `version` (the `toVersion`). Lists are sorted by `caseId`, then `title`.
 */
export const planDiffSchema = z.strictObject({
  fromVersion: z.int().min(1),
  toVersion: z.int().min(1),
  added: z.array(testCaseRefSchema),
  removed: z.array(testCaseRefSchema),
  modified: z.array(modifiedCaseSchema),
});
export type PlanDiff = z.infer<typeof planDiffSchema>;
