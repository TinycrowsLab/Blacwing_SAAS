import { z } from 'zod';

import { type RequestBudget, requestBudgetSchema } from '../budget.js';
import { LIMITS } from '../limits.js';
import { negativeControlProblem, negativeControlSpecSchema } from '../negative-control.js';
import {
  checkTimestamps,
  cweIdSchema,
  labelSchema,
  timestampsShape,
  uuidV7Schema,
} from '../primitives.js';
import { intrusivenessSchema } from './authorisation.js';

/** `test_cases.status` (§7). */
export const TEST_CASE_STATUSES = [
  'proposed',
  'approved',
  'removed',
  'executing',
  'executed',
  'skipped',
  'blocked',
  'failed',
  'model_declined',
  'not_applicable',
] as const;
export const testCaseStatusSchema = z.enum(TEST_CASE_STATUSES);
export type TestCaseStatus = z.infer<typeof testCaseStatusSchema>;

/** `test_plans.status` (§7, PLAN-001). A plan version is a draft until it is proposed, then approved or superseded. */
export const TEST_PLAN_STATUSES = ['draft', 'proposed', 'approved', 'superseded'] as const;
export const testPlanStatusSchema = z.enum(TEST_PLAN_STATUSES);
export type TestPlanStatus = z.infer<typeof testPlanStatusSchema>;

/** Statuses that must carry a `statusReason`. */
export const TEST_CASE_STATUSES_WITH_REASON: readonly TestCaseStatus[] = Object.freeze([
  'removed',
  'skipped',
  'blocked',
  'failed',
  'model_declined',
  'not_applicable',
]);

/**
 * Per-test-case traffic budget (§7 `test_cases.budget`). Defined once in `../budget.ts` (SCOPE-004);
 * kept here as an alias for the entity schemas.
 */
export const testCaseBudgetSchema = requestBudgetSchema;
export type TestCaseBudget = RequestBudget;

/**
 * A declared validation check (§7 `oracle`, `negative_control`). The oracle catalogue (#392) owns the
 * per-type parameter schemas; here `params` is any JSON object.
 */
export const oracleSchema = z.strictObject({
  type: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/, 'must be a lowercase oracle type key'),
  params: z.record(z.string(), z.json()),
});
export type Oracle = z.infer<typeof oracleSchema>;

/** Standards references (`owasp/wstg/asvs refs`, §7). */
export const standardsRefsSchema = z.strictObject({
  owasp: z.array(z.string().min(1)),
  wstg: z.array(z.string().min(1)),
  asvs: z.array(z.string().min(1)),
});
export type StandardsRefs = z.infer<typeof standardsRefsSchema>;

/**
 * The fields the planner proposes for a test case (§7). The entity below adds identity, status and
 * timestamps, so planner output and `test_cases` rows validate against the same field definitions.
 * `class` admits `destructive` on purpose: the plan persistence step rejects it with `CLASS_FORBIDDEN`
 * (§8.3) instead of the schema hiding it.
 */
const plannedTestCaseShape = {
  class: intrusivenessSchema,
  title: labelSchema,
  refs: standardsRefsSchema,
  cweCandidates: z.array(cweIdSchema),
  targets: z.array(z.string().min(1).max(LIMITS.urlMax)).min(1),
  roles: z.array(z.string().min(1).max(LIMITS.shortTextMax)),
  budget: testCaseBudgetSchema,
  oracle: oracleSchema,
  negativeControl: negativeControlSpecSchema.nullable(),
};

/** One test case as proposed by the planner (before it is persisted and given an id). */
export const plannedTestCaseSchema = z.strictObject(plannedTestCaseShape);
export type PlannedTestCase = z.infer<typeof plannedTestCaseSchema>;

/** Most test cases a single plan may propose; a larger plan is invalid output, not a bigger run. */
export const MAX_PLAN_TEST_CASES = 200;

/**
 * The planner's structured output (`outputFormat: { type: 'json_schema' }`, ORCH-005): a list of proposed
 * test cases. An empty list parses (the orchestrator fails the run with `PLAN_EMPTY`, which is not a
 * schema problem and is not retried).
 */
export const testPlanSchema = z.strictObject({
  testCases: z.array(plannedTestCaseSchema).max(MAX_PLAN_TEST_CASES),
});
export type TestPlan = z.infer<typeof testPlanSchema>;

/** {@link testPlanSchema} as a JSON Schema (draft 2020-12), the `schema` of the planner's `outputFormat`. */
export function testPlanJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(testPlanSchema, { target: 'draft-2020-12', io: 'input' });
}

/**
 * A planned test case, §7 `test_plans → test_cases`. The planner contracts (#427) extend it.
 *
 * Rules: a test case always declares its oracle (no finding without a deterministic check, §8.11);
 * statuses such as `blocked` or `skipped` record a `statusReason`; a `destructive` test case can never be
 * `approved`, `executing` or `executed` (§8.3).
 */
export const testCaseSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    testPlanId: uuidV7Schema,
    ...plannedTestCaseShape,
    status: testCaseStatusSchema,
    statusReason: z.string().min(1).max(LIMITS.reasonMax).nullable(),
    ...timestampsShape,
  })
  .superRefine((testCase, ctx) => {
    checkTimestamps(testCase, ctx);
    if (
      TEST_CASE_STATUSES_WITH_REASON.includes(testCase.status) &&
      testCase.statusReason === null
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['statusReason'],
        message: `status ${testCase.status} needs a reason`,
      });
    }
    // Every non-passive case declares a negative control (F16). Whether a control suits its oracle is
    // checked by `assertNegativeControl`, where the oracle catalogue is known.
    if (negativeControlProblem(testCase) === 'NEGATIVE_CONTROL_MISSING') {
      ctx.addIssue({
        code: 'custom',
        path: ['negativeControl'],
        message: 'NEGATIVE_CONTROL_MISSING: a non-passive test case needs a negative control',
      });
    }
    const running =
      testCase.status === 'approved' ||
      testCase.status === 'executing' ||
      testCase.status === 'executed';
    if (testCase.class === 'destructive' && running) {
      ctx.addIssue({
        code: 'custom',
        path: ['class'],
        message: 'a destructive test case can never run',
      });
    }
  });
export type TestCase = z.infer<typeof testCaseSchema>;
