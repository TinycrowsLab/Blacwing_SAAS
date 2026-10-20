import { z } from 'zod';

import { LIMITS } from '../limits.js';
import {
  checkTimestamps,
  cweIdSchema,
  labelSchema,
  timestampsShape,
  uuidV7Schema,
} from '../primitives.js';
import { intrusivenessSchema } from './authorisation.js';

/** `test_cases.status` (§7). */
export const testCaseStatusSchema = z.enum([
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
]);
export type TestCaseStatus = z.infer<typeof testCaseStatusSchema>;

/** Statuses that must carry a `statusReason`. */
export const TEST_CASE_STATUSES_WITH_REASON: readonly TestCaseStatus[] = Object.freeze([
  'removed',
  'skipped',
  'blocked',
  'failed',
  'model_declined',
  'not_applicable',
]);

/** Per-test-case traffic budget (§7 `test_cases.budget`). */
export const testCaseBudgetSchema = z.strictObject({
  maxRequests: z.int().positive(),
  maxRps: z.number().positive(),
  maxConcurrency: z.int().positive(),
  maxBytes: z.int().positive(),
});
export type TestCaseBudget = z.infer<typeof testCaseBudgetSchema>;

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
    class: intrusivenessSchema,
    title: labelSchema,
    refs: standardsRefsSchema,
    cweCandidates: z.array(cweIdSchema),
    targets: z.array(z.string().min(1).max(LIMITS.urlMax)).min(1),
    roles: z.array(z.string().min(1).max(LIMITS.shortTextMax)),
    budget: testCaseBudgetSchema,
    oracle: oracleSchema,
    negativeControl: oracleSchema.nullable(),
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
