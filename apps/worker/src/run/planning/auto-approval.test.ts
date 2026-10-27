import { describe, expect, it } from 'vitest';

import { evaluateAutoApproval } from './auto-approval.js';
import { checkPlan } from './plan-check.js';
import { EXPIRED_AT, sa, testCase } from './testing.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');

describe('evaluateAutoApproval', () => {
  it('approves when every case is inside the SA classes and budgets', () => {
    const decision = evaluateAutoApproval(
      [testCase({ class: 'passive' }), testCase(), testCase()],
      sa(),
      NOW,
    );
    expect(decision).toEqual({ eligible: true, blockers: [] });
  });

  it('one out-of-envelope case forces a manual Gate 1 and names it', () => {
    const decision = evaluateAutoApproval(
      [testCase(), testCase({ budget: { ...testCase().budget, maxRequests: 5000 } }), testCase()],
      sa(),
      NOW,
    );
    expect(decision.eligible).toBe(false);
    expect(decision.blockers).toEqual([{ code: 'BUDGET_EXCEEDS_SA', index: 1 }]);
  });

  it('a class the SA does not pre-approve blocks, whatever its budget', () => {
    const decision = evaluateAutoApproval(
      [testCase(), testCase()],
      sa({ preApprovedTestClasses: ['passive'] }),
      NOW,
    );
    expect(decision.blockers).toEqual([
      { code: 'CLASS_NOT_PRE_APPROVED', index: 0 },
      { code: 'CLASS_NOT_PRE_APPROVED', index: 1 },
    ]);
  });

  it('state_changing always needs an explicit Gate 1, even when the SA lists it (§8.3)', () => {
    const decision = evaluateAutoApproval(
      [testCase({ class: 'state_changing' })],
      sa({ preApprovedTestClasses: ['passive', 'active_safe', 'state_changing'] }),
      NOW,
    );
    expect(decision).toEqual({
      eligible: false,
      blockers: [{ code: 'STATE_CHANGING_NEEDS_GATE1', index: 0 }],
    });
  });

  it('destructive is never pre-approved, even if an SA lists it', () => {
    const decision = evaluateAutoApproval(
      [testCase({ class: 'destructive' })],
      sa({ preApprovedTestClasses: ['destructive'] }),
      NOW,
    );
    expect(decision.eligible).toBe(false);
  });

  it('an empty plan is never eligible', () => {
    expect(evaluateAutoApproval([], sa(), NOW).blockers).toEqual([{ code: 'PLAN_EMPTY' }]);
  });

  it('an SA that is not active, or has expired, never auto-approves', () => {
    for (const over of [
      { status: 'revoked' as const },
      { status: 'draft' as const },
      { expiresAt: EXPIRED_AT },
    ]) {
      expect(evaluateAutoApproval([testCase()], sa(over), NOW).blockers).toEqual([
        { code: 'SA_NOT_ACTIVE' },
      ]);
    }
  });

  it('a budget exactly at the SA bound is inside it', () => {
    const exact = testCase({ budget: { ...testCase().budget, maxRequests: 1000 } });
    expect(evaluateAutoApproval([exact], sa(), NOW).eligible).toBe(true);
  });
});

describe('checkPlan', () => {
  const ceiling = { maxIntrusiveness: 'active_safe' as const };

  it('accepts a valid plan', () => {
    const result = checkPlan({ testCases: [testCase()] }, ceiling);
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects malformed output with paths and messages but no plan values', () => {
    const result = checkPlan(
      { testCases: [{ ...testCase(), title: 'SECRET-TITLE', oracle: 'nope' }] },
      ceiling,
    );
    expect(result).toMatchObject({ ok: false, code: 'PLAN_INVALID' });
    expect(JSON.stringify(result)).not.toContain('SECRET-TITLE');
    expect(JSON.stringify(result)).toContain('testCases.0.oracle');
  });

  it.each([null, 'text', [], {}, { testCases: 'x' }])('rejects non-plan output %j', (raw) => {
    expect(checkPlan(raw, ceiling)).toMatchObject({ ok: false, code: 'PLAN_INVALID' });
  });

  it('flags an empty plan as PLAN_EMPTY', () => {
    expect(checkPlan({ testCases: [] }, ceiling)).toMatchObject({ ok: false, code: 'PLAN_EMPTY' });
  });

  it('rejects a destructive case with CLASS_FORBIDDEN, even next to valid ones', () => {
    const result = checkPlan(
      { testCases: [testCase(), testCase({ class: 'destructive' })] },
      { maxIntrusiveness: 'state_changing' },
    );
    expect(result).toMatchObject({ ok: false, code: 'CLASS_FORBIDDEN' });
  });

  it('rejects a class above the SA ceiling', () => {
    const result = checkPlan({ testCases: [testCase({ class: 'state_changing' })] }, ceiling);
    expect(result).toMatchObject({ ok: false, code: 'CLASS_EXCEEDS_SA' });
  });
});
