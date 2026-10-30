// Planner contracts (#427): standards refs are checked against their id formats, and a planned test case
// requires its budget, class and targets.

import { describe, expect, it } from 'vitest';

import { plannedTestCaseSchema, standardsRefsSchema } from './test-case.js';

const validRefs = {
  owasp: ['A01', 'A10:2021', 'API1', 'API10'],
  wstg: ['WSTG-ATHZ-02'],
  asvs: ['v5.0.0-4.2.1', '5.3.3'],
};

const plannedCase = {
  class: 'active_safe',
  title: 'Unauthenticated admin access',
  refs: validRefs,
  cweCandidates: ['CWE-284'],
  targets: ['https://app.example.test/admin'],
  roles: ['anonymous'],
  budget: { maxRequests: 10, maxRps: 1, maxConcurrency: 1, maxBytes: 1_000_000 },
  oracle: { type: 'response.status', params: { expected: 403 } },
  negativeControl: {
    kind: 'known_safe_endpoint',
    description: 'Same request to the public page',
    oracleMustNotFire: true,
    params: {},
  },
};

describe('standards refs id formats (#427)', () => {
  it.each([
    ['owasp', 'A11'],
    ['owasp', 'A1'],
    ['owasp', 'A00'],
    ['owasp', 'API11'],
    ['owasp', 'A01 ✓'],
    ['wstg', 'WSTG-athz-02'],
    ['wstg', 'WSTG-ATHZ-2'],
    ['wstg', 'ATHZ-02'],
    ['asvs', 'v4.0-1'],
    ['asvs', 'v5.0.0-4.2'],
    ['asvs', '4.2'],
  ])('rejects the malformed %s ref %s', (field, value) => {
    const result = standardsRefsSchema.safeParse({ ...validRefs, [field]: [value] });
    expect(result.success).toBe(false);
  });

  it('accepts every well-formed id in the table', () => {
    expect(standardsRefsSchema.safeParse(validRefs).success).toBe(true);
    expect(standardsRefsSchema.safeParse({ owasp: [], wstg: [], asvs: [] }).success).toBe(true);
  });

  it('rejects a ref list that carries an unknown key', () => {
    expect(standardsRefsSchema.safeParse({ ...validRefs, cwe: ['CWE-89'] }).success).toBe(false);
  });
});

describe('planned test case required fields (#427)', () => {
  it('accepts a complete active_safe case', () => {
    expect(plannedTestCaseSchema.safeParse(plannedCase).success).toBe(true);
  });

  it('rejects a case with a malformed ref and names the field', () => {
    const result = plannedTestCaseSchema.safeParse({
      ...plannedCase,
      refs: { ...validRefs, wstg: ['WSTG-athz-02'] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join('.') === 'refs.wstg.0')).toBe(true);
  });

  it('rejects a case missing budget, class or targets, and empty targets', () => {
    for (const key of ['budget', 'class', 'targets']) {
      const rest = Object.fromEntries(Object.entries(plannedCase).filter(([name]) => name !== key));
      expect(plannedTestCaseSchema.safeParse(rest).success, key).toBe(false);
    }
    expect(plannedTestCaseSchema.safeParse({ ...plannedCase, targets: [] }).success).toBe(false);
  });

  it('rejects a zero budget field', () => {
    expect(
      plannedTestCaseSchema.safeParse({
        ...plannedCase,
        budget: { ...plannedCase.budget, maxBytes: 0 },
      }).success,
    ).toBe(false);
  });
});
