import { z } from 'zod';

import { type RequestBudget, requestBudgetSchema } from '../budget.js';
import { LIMITS } from '../limits.js';
import { isoDateTimeSchema, labelSchema } from '../primitives.js';
import { intrusivenessSchema } from './authorisation.js';
import { runStateSchema } from './run.js';

/**
 * Gate 1 (test plan approval) contracts (#877, CONTEXT_PACK §3.2, §8.4). The approver reads the plan and
 * records one decision. The server enforces authorisation, separation of duties and state; these schemas
 * only shape the wire format.
 */

/** Public run id (`run_…`), as the console and the run contracts carry it. */
export const gate1RunIdSchema = z.string().regex(/^run_[0-9A-Za-z]{4,64}$/, 'must be a run id');

/** Largest reason an approver may attach to a decision. */
export const GATE1_REASON_MAX = 2000;

export const GATE1_DECISIONS = ['approve', 'request_changes', 'reject'] as const;
export const gate1DecisionSchema = z.enum(GATE1_DECISIONS);
export type Gate1Decision = z.infer<typeof gate1DecisionSchema>;

/** Decisions that send the plan back or end the run, so they need a stated reason (#877 requirement 2). */
export const GATE1_DECISIONS_REQUIRING_REASON: readonly Gate1Decision[] = Object.freeze([
  'request_changes',
  'reject',
]);

/** Body of `POST /v1/runs/{runId}/gate1/decisions`. `planVersion` is the version the approver reviewed. */
export const gate1DecisionRequestSchema = z
  .strictObject({
    decision: gate1DecisionSchema,
    planVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().max(GATE1_REASON_MAX).optional(),
  })
  .superRefine((value, ctx) => {
    const reason = value.reason ?? '';
    if (GATE1_DECISIONS_REQUIRING_REASON.includes(value.decision) && reason.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a reason is required for request_changes and reject',
        path: ['reason'],
      });
    }
  });
export type Gate1DecisionRequest = z.infer<typeof gate1DecisionRequestSchema>;

/** Answer to a recorded (or replayed) decision. */
export const gate1DecisionResponseSchema = z.strictObject({
  runId: gate1RunIdSchema,
  decision: gate1DecisionSchema,
  planVersion: z.number().int().positive(),
  runState: runStateSchema,
  decidedAt: isoDateTimeSchema,
});
export type Gate1DecisionResponse = z.infer<typeof gate1DecisionResponseSchema>;

/** One test case as the approver sees it. */
export const gate1TestCaseSchema = z.strictObject({
  id: z.string().min(1).max(LIMITS.shortTextMax),
  title: labelSchema,
  class: intrusivenessSchema,
  targets: z.array(z.string().min(1).max(LIMITS.urlMax)),
  budget: requestBudgetSchema,
});
export type Gate1TestCase = z.infer<typeof gate1TestCaseSchema>;

/** Which test cases a plan version added, removed or changed compared with the version before it. */
export const gate1PlanChangesSchema = z.strictObject({
  fromVersion: z.number().int().positive(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});
export type Gate1PlanChanges = z.infer<typeof gate1PlanChangesSchema>;

/**
 * What the approver's review screen shows (`GET /v1/runs/{runId}/gate1`). `viewer` is derived on the
 * server: `canDecide` is false for the requester, for a caller without `testplan:approve`, and for a run
 * that is not waiting at Gate 1. It is a UX hint only; the decision endpoint enforces the same rules.
 */
export const gate1PlanViewSchema = z.strictObject({
  runId: gate1RunIdSchema,
  runState: runStateSchema,
  planVersion: z.number().int().positive(),
  requesterId: z.string().min(1).max(LIMITS.shortTextMax).nullable(),
  requestedAt: isoDateTimeSchema,
  /** Instant after which Gate 1 can no longer be decided; null when the plan has no window. */
  expiresAt: isoDateTimeSchema.nullable(),
  testCases: z.array(gate1TestCaseSchema),
  budgetTotals: z.strictObject({
    maxRequests: z.number().int().nonnegative(),
    maxBytes: z.number().int().nonnegative(),
  }),
  changes: gate1PlanChangesSchema.nullable(),
  viewer: z.strictObject({
    canDecide: z.boolean(),
    isRequester: z.boolean(),
  }),
});
export type Gate1PlanView = z.infer<typeof gate1PlanViewSchema>;

/** Sums the additive request-budget dimensions of a plan (rate and concurrency are not additive). */
export function gate1BudgetTotals(
  budgets: readonly RequestBudget[],
): Gate1PlanView['budgetTotals'] {
  return budgets.reduce(
    (total, budget) => ({
      maxRequests: total.maxRequests + budget.maxRequests,
      maxBytes: total.maxBytes + budget.maxBytes,
    }),
    { maxRequests: 0, maxBytes: 0 },
  );
}
