import {
  isWithinCeiling,
  type PlannedTestCase,
  testPlanSchema,
  type StandingAuthorisation,
} from '@blackwing/contracts';

import type { PlanRejectionCode } from './types.js';

const MAX_DETAIL_CHARS = 500;
const MAX_ISSUES = 5;

export type PlanCheck =
  | { readonly ok: true; readonly testCases: readonly PlannedTestCase[] }
  | { readonly ok: false; readonly code: PlanRejectionCode; readonly detail: string };

/**
 * Validates the planner's raw structured output before anything is persisted (ORCH-005). The output is
 * untrusted data: it must parse against the shared plan schema, must not be empty, must never contain a
 * `destructive` case (§8.3) and must not exceed the SA's `maxIntrusiveness`. The detail names paths and
 * messages only, never plan values, because it is fed back to the planner as retry feedback.
 */
export function checkPlan(
  raw: unknown,
  sa: Pick<StandingAuthorisation, 'maxIntrusiveness'>,
): PlanCheck {
  const parsed = testPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, MAX_ISSUES)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, code: 'PLAN_INVALID', detail: detail.slice(0, MAX_DETAIL_CHARS) };
  }
  const { testCases } = parsed.data;
  if (testCases.length === 0) {
    return { ok: false, code: 'PLAN_EMPTY', detail: 'The plan has no test cases' };
  }
  const destructive = testCases.findIndex((testCase) => testCase.class === 'destructive');
  if (destructive !== -1) {
    return {
      ok: false,
      code: 'CLASS_FORBIDDEN',
      detail: `testCases.${String(destructive)}.class: the destructive class is never allowed`,
    };
  }
  const above = testCases.findIndex(
    (testCase) => !isWithinCeiling(testCase.class, sa.maxIntrusiveness),
  );
  if (above !== -1) {
    return {
      ok: false,
      code: 'CLASS_EXCEEDS_SA',
      detail: `testCases.${String(above)}.class: exceeds the standing authorisation ceiling`,
    };
  }
  return { ok: true, testCases };
}
