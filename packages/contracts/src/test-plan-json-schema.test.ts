// The planner's `outputFormat` JSON Schema (#427) must be a self-contained schema that Ajv (the validator
// family the SDK uses) accepts in strict mode, and that rejects the same shapes the Zod contract rejects.

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { testPlanJsonSchema } from './index.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validatePlan = ajv.compile(testPlanJsonSchema());

const oracle = { type: 'response.status', params: { expected: 403 } };
const negativeControl = {
  kind: 'known_safe_endpoint',
  description: 'Same request to the public page',
  oracleMustNotFire: true,
  params: {},
};
const proposed = {
  class: 'active_safe',
  title: 'Unauthenticated admin access',
  refs: { owasp: ['A01:2021'], wstg: ['WSTG-ATHZ-02'], asvs: [] },
  cweCandidates: ['CWE-284'],
  targets: ['https://app.example.test/admin'],
  roles: ['anonymous'],
  budget: { maxRequests: 10, maxRps: 1, maxConcurrency: 1, maxBytes: 1_000_000 },
  oracle,
  negativeControl,
};

/** Returns a copy of `base` without `key`, typed loosely for the negative cases below. */
function without(base: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));
}

describe('planner outputFormat JSON Schema (#427)', () => {
  it('compiles in Ajv strict mode and accepts a valid plan', () => {
    expect(validatePlan({ testCases: [proposed] })).toBe(true);
    expect(validatePlan({ testCases: [] })).toBe(true);
  });

  it('rejects a negative control that may fire', () => {
    expect(
      validatePlan({
        testCases: [
          { ...proposed, negativeControl: { ...negativeControl, oracleMustNotFire: false } },
        ],
      }),
    ).toBe(false);
  });

  it('rejects a case missing budget, class or targets', () => {
    for (const key of ['budget', 'class', 'targets']) {
      expect(validatePlan({ testCases: [without(proposed, key)] }), key).toBe(false);
    }
  });

  it('rejects a non-positive budget field', () => {
    expect(
      validatePlan({
        testCases: [{ ...proposed, budget: { ...proposed.budget, maxRequests: 0 } }],
      }),
    ).toBe(false);
  });

  it('rejects an unknown class, unknown keys and server-assigned fields', () => {
    expect(validatePlan({ testCases: [{ ...proposed, class: 'exploit' }] })).toBe(false);
    expect(validatePlan({ testCases: [{ ...proposed, extra: 1 }] })).toBe(false);
    expect(validatePlan({ testCases: [{ ...proposed, status: 'approved' }] })).toBe(false);
    expect(validatePlan({ testCases: [proposed], extra: 1 })).toBe(false);
  });
});
