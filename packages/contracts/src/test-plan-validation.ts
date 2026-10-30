import { z } from 'zod';

import { uuidV7Schema } from './primitives.js';

/**
 * Plan validation contracts (PLAN-006, #396, CONTEXT_PACK §8.1, §8.3, §8.6). A validation checks one test plan
 * version against its run's standing authorisation (SA), the customer Cedar policy and the run budgets. Its
 * answer is data: `ok` is true only when `violations` is empty. A violation carries a stable `code`, the case it
 * concerns (or null for a plan-level finding) and, for a Cedar refusal, the id of the policy that decided it.
 * Messages are static text: they never echo a target, a title or any other input value.
 */

/** Stable codes of a plan validation violation. Each is registered here, never built from input. */
export const PLAN_VIOLATION_CODES = [
  'PLAN_SA_MISSING',
  'PLAN_SA_NOT_ACTIVE',
  'PLAN_CLASS_DESTRUCTIVE_BLOCKED',
  'PLAN_CLASS_EXCEEDS_SA',
  'PLAN_STATE_CHANGING_NOT_AUTHORISED',
  'PLAN_TARGET_OUT_OF_SCOPE',
  'PLAN_ROLE_UNKNOWN',
  'PLAN_ORACLE_MISSING',
  'PLAN_NEGATIVE_CONTROL_MISSING',
  'PLAN_BUDGET_EXCEEDED',
  'PLAN_POLICY_DENIED',
  'PLAN_POLICY_EVAL_FAILED',
] as const;
export const planViolationCodeSchema = z.enum(PLAN_VIOLATION_CODES);
export type PlanViolationCode = z.infer<typeof planViolationCodeSchema>;

const POLICY_ID_MAX = 128;
const MESSAGE_MAX = 256;

/** One reason a plan version is not valid. `caseId` is null for a plan-level finding. */
export const planViolationSchema = z.strictObject({
  code: planViolationCodeSchema,
  caseId: uuidV7Schema.nullable(),
  /** The Cedar policy id that decided a `PLAN_POLICY_DENIED`; null when no policy did. */
  policyId: z.string().min(1).max(POLICY_ID_MAX).nullable(),
  message: z.string().min(1).max(MESSAGE_MAX),
});
export type PlanViolation = z.infer<typeof planViolationSchema>;

/** Totals of the non-removed cases of a plan version (the UI budget panel reads them). */
export const planBudgetTotalsSchema = z.strictObject({
  totalRequests: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  perClassCounts: z.strictObject({
    passive: z.number().int().min(0),
    active_safe: z.number().int().min(0),
    state_changing: z.number().int().min(0),
    destructive: z.number().int().min(0),
  }),
});
export type PlanBudgetTotals = z.infer<typeof planBudgetTotalsSchema>;

/** `GET /v1/test-plans/{planId}/validation` answer. */
export const planValidationResultSchema = z.strictObject({
  planId: uuidV7Schema,
  runId: uuidV7Schema,
  version: z.int().min(1),
  /** The SA the plan was validated against; null when the run has none (`PLAN_SA_MISSING`). */
  saId: uuidV7Schema.nullable(),
  ok: z.boolean(),
  /** True when at least one case is not pre-approved by the SA, so a human Gate 1 decision is required (§8.3). */
  gate1Required: z.boolean(),
  violations: z.array(planViolationSchema),
  budgetTotals: planBudgetTotalsSchema,
  validatedAt: z.iso.datetime(),
});
export type PlanValidationResult = z.infer<typeof planValidationResultSchema>;
