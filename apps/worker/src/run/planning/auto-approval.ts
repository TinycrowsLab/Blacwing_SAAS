import { isWithinSaDefaults, type PlannedTestCase } from '@blackwing/contracts';

import type { PlanningSa } from './ports.js';

// Pure Gate 1 auto-approval rule (§3.2 step 6, §8.3). No IO, so it is bundled into nothing and tested
// directly. Safety is deterministic code, never the model's say-so (§8.11).

type AutoApprovalBlockerCode =
  | 'SA_NOT_ACTIVE'
  | 'PLAN_EMPTY'
  | 'CLASS_NOT_PRE_APPROVED'
  | 'STATE_CHANGING_NEEDS_GATE1'
  | 'BUDGET_EXCEEDS_SA';

interface AutoApprovalBlocker {
  readonly code: AutoApprovalBlockerCode;
  /** Index of the offending test case; absent for plan-level blockers. */
  readonly index?: number;
}

export interface AutoApprovalDecision {
  readonly eligible: boolean;
  readonly blockers: readonly AutoApprovalBlocker[];
}

/**
 * A plan may be approved under the standing authorisation only when the SA is active and unexpired and
 * EVERY test case is inside it: its class is one of the SA's `preApprovedTestClasses`, it is not
 * `state_changing` (that always needs an explicit Gate 1 approval, §8.3) and its budget does not exceed
 * the SA's `defaultBudgets`. One out-of-envelope case forces a manual Gate 1; an empty plan is never
 * eligible (nothing to approve is not a vacuous yes).
 */
export function evaluateAutoApproval(
  testCases: readonly PlannedTestCase[],
  sa: PlanningSa,
  now: Date,
): AutoApprovalDecision {
  const blockers: AutoApprovalBlocker[] = [];
  if (sa.status !== 'active' || Date.parse(sa.expiresAt) <= now.getTime()) {
    blockers.push({ code: 'SA_NOT_ACTIVE' });
  }
  if (testCases.length === 0) blockers.push({ code: 'PLAN_EMPTY' });
  testCases.forEach((testCase, index) => {
    if (testCase.class === 'state_changing') {
      blockers.push({ code: 'STATE_CHANGING_NEEDS_GATE1', index });
    } else if (
      testCase.class === 'destructive' ||
      !sa.preApprovedTestClasses.includes(testCase.class)
    ) {
      blockers.push({ code: 'CLASS_NOT_PRE_APPROVED', index });
    }
    if (!isWithinSaDefaults(testCase.budget, sa.defaultBudgets)) {
      blockers.push({ code: 'BUDGET_EXCEEDS_SA', index });
    }
  });
  return { eligible: blockers.length === 0, blockers };
}
