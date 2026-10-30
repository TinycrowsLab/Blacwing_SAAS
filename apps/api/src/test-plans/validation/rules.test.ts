import { describe, expect, it } from 'vitest';

import {
  activeAuthorisation,
  CASE_ID,
  caseRow,
  NOW,
  RUN_BUDGETS,
  SECOND_CASE_ID,
} from './fixtures.test-helpers.js';
import {
  budgetOf,
  budgetTotals,
  type CaseFacts,
  gate1Required,
  parseTarget,
  type PlanFacts,
  planViolations,
  saIsActive,
  scopeRulesOf,
  targetInScope,
} from './rules.js';

import type { PlanViolationCode } from '@blackwing/contracts';

/** Facts of the one valid case of the default snapshot. */
function factsOf(
  cases: readonly Partial<CaseFacts>[],
  sa = activeAuthorisation(),
  knownRoles: readonly string[] | null = ['anonymous', 'customer'],
): PlanFacts {
  const built = cases.map((c): CaseFacts => ({
    id: CASE_ID,
    class: 'active_safe',
    targets: ['https://app.example.test/search'],
    roles: ['anonymous'],
    budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 2, maxBytes: 100_000 },
    oracle: { type: 'response.contains', params: {} },
    negativeControl: { type: 'response.contains', params: {} },
    ...c,
  }));
  return { cases: built, sa, knownRoles, runBudgets: RUN_BUDGETS };
}

function codesOf(facts: PlanFacts): PlanViolationCode[] {
  return planViolations(facts, budgetTotals(facts.cases)).map((v) => v.code);
}

describe('saIsActive', () => {
  const sa = activeAuthorisation();
  it('is active inside the window', () => {
    expect(saIsActive(sa, NOW)).toBe(true);
  });
  it('includes validFrom and excludes expiresAt (half-open window)', () => {
    expect(saIsActive(sa, sa.validFrom)).toBe(true);
    expect(saIsActive(sa, sa.expiresAt)).toBe(false);
    expect(saIsActive(sa, new Date(sa.validFrom.getTime() - 1))).toBe(false);
  });
  it('is inactive for any status but active (expired, revoked, draft)', () => {
    for (const status of ['draft', 'pending_approval', 'expired', 'revoked'] as const) {
      expect(saIsActive({ ...sa, status }, NOW)).toBe(false);
    }
  });
});

describe('parseTarget', () => {
  it('reads host, port, path of an http(s) URL with the scheme default port', () => {
    expect(parseTarget('https://app.example.test/search?q=1')).toEqual({
      host: 'app.example.test',
      port: 443,
      path: '/search',
    });
    expect(parseTarget('http://app.example.test:8080/x')).toEqual({
      host: 'app.example.test',
      port: 8080,
      path: '/x',
    });
  });
  it('reads an IP literal as ip, not host', () => {
    expect(parseTarget('http://10.0.0.5/')).toEqual({ ip: '10.0.0.5', port: 80, path: '/' });
    expect(parseTarget('http://[::1]:8000/')).toEqual({ ip: '::1', port: 8000, path: '/' });
  });
  it('rejects anything that is not an http(s) URL with a host (fail closed)', () => {
    for (const raw of [
      'app.example.test',
      'ftp://app.example.test/',
      'data:text/html,<p>x</p>',
      'file:///etc/passwd',
      'http://',
      'not a url',
      42,
      null,
    ]) {
      expect(parseTarget(raw)).toBeUndefined();
    }
  });
});

describe('targetInScope and scopeRulesOf', () => {
  const rules = scopeRulesOf({
    rules: [
      { effect: 'include', host: '*.example.test' },
      { effect: 'exclude', host: 'admin.example.test' },
    ],
  });
  it('places a wildcard match in scope and an excluded host out of scope', () => {
    expect(targetInScope('https://app.example.test/search', rules)).toBe(true);
    expect(targetInScope('https://admin.example.test/', rules)).toBe(false);
  });
  it('treats an unmatched host, the apex of a wildcard and a bad target as out of scope', () => {
    expect(targetInScope('https://example.test/', rules)).toBe(false);
    expect(targetInScope('https://other.test/', rules)).toBe(false);
    expect(targetInScope('ftp://app.example.test/', rules)).toBe(false);
  });
  it('treats every target as out of scope when the SA rules do not parse', () => {
    expect(scopeRulesOf({ rules: [{ effect: 'include' }] })).toBeUndefined();
    expect(targetInScope('https://app.example.test/', undefined)).toBe(false);
  });
  it('does not put a private IP in scope through a host rule', () => {
    expect(targetInScope('http://10.0.0.5/', rules)).toBe(false);
  });
  it('puts a private IP in scope only through an explicit cidr rule', () => {
    const cidr = scopeRulesOf({ rules: [{ effect: 'include', cidr: '10.0.0.0/8' }] });
    expect(targetInScope('http://10.0.0.5/', cidr)).toBe(true);
    expect(targetInScope('http://192.168.1.1/', cidr)).toBe(false);
  });
});

describe('budgetOf and budgetTotals', () => {
  it('parses request and byte caps and rejects a malformed budget', () => {
    expect(budgetOf({ maxRequests: 3, maxBytes: 9, maxRps: 1, maxConcurrency: 1 })).toEqual({
      maxRequests: 3,
      maxBytes: 9,
    });
    expect(budgetOf({ maxRequests: '3' })).toBeUndefined();
    expect(budgetOf(null)).toBeUndefined();
  });
  it('sums requests and bytes and counts cases per class', () => {
    const totals = budgetTotals(
      factsOf([
        { class: 'passive', budget: { maxRequests: 10, maxBytes: 100 } },
        { class: 'active_safe', budget: { maxRequests: 5, maxBytes: 50 } },
        { class: 'active_safe', budget: { maxRequests: 'bad' } },
      ]).cases,
    );
    expect(totals).toEqual({
      totalRequests: 15,
      totalBytes: 150,
      perClassCounts: { passive: 1, active_safe: 2, state_changing: 0, destructive: 0 },
    });
  });
});

describe('planViolations', () => {
  it('reports nothing for a valid plan', () => {
    expect(codesOf(factsOf([{}]))).toEqual([]);
  });

  it('always reports a destructive case, and reports no other check for it', () => {
    expect(codesOf(factsOf([{ class: 'destructive', targets: [] }]))).toEqual([
      'PLAN_CLASS_DESTRUCTIVE_BLOCKED',
    ]);
  });

  it('refuses a class above the SA maximum', () => {
    const facts = factsOf(
      [{ class: 'state_changing' }],
      activeAuthorisation({
        maxIntrusiveness: 'active_safe',
        preApprovedTestClasses: ['state_changing'],
      }),
    );
    expect(codesOf(facts)).toContain('PLAN_CLASS_EXCEEDS_SA');
  });

  it('refuses state_changing unless the SA pre-approves that class', () => {
    const sa = activeAuthorisation({
      maxIntrusiveness: 'state_changing',
      preApprovedTestClasses: [],
    });
    expect(codesOf(factsOf([{ class: 'state_changing' }], sa))).toContain(
      'PLAN_STATE_CHANGING_NOT_AUTHORISED',
    );
    const approved = activeAuthorisation({
      maxIntrusiveness: 'state_changing',
      preApprovedTestClasses: ['state_changing'],
    });
    expect(codesOf(factsOf([{ class: 'state_changing' }], approved))).not.toContain(
      'PLAN_STATE_CHANGING_NOT_AUTHORISED',
    );
  });

  it('refuses a target outside the scope, with the case id and no target text', () => {
    const [found] = planViolations(
      factsOf([{ targets: ['https://evil.test/secret-path'] }]),
      budgetTotals([caseRow()]),
    );
    expect(found).toMatchObject({
      code: 'PLAN_TARGET_OUT_OF_SCOPE',
      caseId: CASE_ID,
      policyId: null,
    });
    expect(found?.message).not.toContain('evil.test');
  });

  it('refuses a case without targets (nothing to check means nothing is authorised)', () => {
    expect(codesOf(factsOf([{ targets: [] }]))).toContain('PLAN_TARGET_OUT_OF_SCOPE');
  });

  it('refuses a role the asset role matrix does not declare, and every role when none is known', () => {
    expect(codesOf(factsOf([{ roles: ['admin'] }]))).toContain('PLAN_ROLE_UNKNOWN');
    expect(codesOf(factsOf([{ roles: ['anonymous'] }], undefined, null))).toContain(
      'PLAN_ROLE_UNKNOWN',
    );
    expect(codesOf(factsOf([{ roles: [] }], undefined, null))).toContain('PLAN_ROLE_UNKNOWN');
  });

  it('refuses a missing oracle and a missing negative control, but not for passive cases', () => {
    expect(codesOf(factsOf([{ oracle: null }]))).toContain('PLAN_ORACLE_MISSING');
    expect(codesOf(factsOf([{ negativeControl: null }]))).toContain(
      'PLAN_NEGATIVE_CONTROL_MISSING',
    );
    expect(codesOf(factsOf([{ class: 'passive', negativeControl: null }]))).not.toContain(
      'PLAN_NEGATIVE_CONTROL_MISSING',
    );
  });

  it('refuses a case budget above the SA default, and a malformed case budget', () => {
    expect(codesOf(factsOf([{ budget: { maxRequests: 101, maxBytes: 1 } }]))).toContain(
      'PLAN_BUDGET_EXCEEDED',
    );
    expect(codesOf(factsOf([{ budget: { maxRequests: 1, maxBytes: 1_000_001 } }]))).toContain(
      'PLAN_BUDGET_EXCEEDED',
    );
    expect(codesOf(factsOf([{ budget: { maxRequests: 'x' } }]))).toContain('PLAN_BUDGET_EXCEEDED');
  });

  it('refuses an aggregate above the run request budget, with no case id', () => {
    const facts = {
      ...factsOf([
        { budget: { maxRequests: 60, maxBytes: 1 } },
        { id: SECOND_CASE_ID, budget: { maxRequests: 60, maxBytes: 1 } },
      ]),
      runBudgets: { maxRequests: 100 },
    };
    const found = planViolations(facts, budgetTotals(facts.cases)).filter(
      (v) => v.code === 'PLAN_BUDGET_EXCEEDED',
    );
    expect(found.map((v) => v.caseId)).toEqual([null]);
  });

  it('collapses duplicate codes on one case', () => {
    const facts = factsOf([{ oracle: null, roles: ['x', 'y'] }]);
    const codes = codesOf(facts).filter((c) => c === 'PLAN_ROLE_UNKNOWN');
    expect(codes).toHaveLength(1);
  });
});

describe('gate1Required', () => {
  it('is required when any case class is not pre-approved, and not when all are', () => {
    expect(gate1Required(factsOf([{}]))).toBe(true);
    const approved = activeAuthorisation({ preApprovedTestClasses: ['active_safe'] });
    expect(gate1Required(factsOf([{}], approved))).toBe(false);
  });
  it('is required for any case when the SA pre-approves no class at all', () => {
    expect(
      gate1Required(
        factsOf([{ class: 'passive' }], activeAuthorisation({ preApprovedTestClasses: [] })),
      ),
    ).toBe(true);
  });
});
