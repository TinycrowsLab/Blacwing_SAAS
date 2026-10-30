import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createCedarPlanPolicy,
  PLAN_POLICY_SET,
  type PlanPolicyPrincipal,
  type PlanPolicyResource,
  PlanPolicyLoadError,
} from './policy.js';

interface Vector {
  readonly name: string;
  readonly principal: PlanPolicyPrincipal;
  readonly resource: PlanPolicyResource;
  readonly expect: { readonly decision: 'allow' | 'deny'; readonly policyIds: readonly string[] };
}

const VECTORS: { version: number; vectors: Vector[] } = JSON.parse(
  readFileSync(new URL('./plan-policy.vectors.json', import.meta.url), 'utf8'),
) as { version: number; vectors: Vector[] };

const engine = createCedarPlanPolicy();

describe('plan policy shared vectors', () => {
  it.each(VECTORS.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const decision = engine.evaluate(vector.principal, vector.resource);
    expect(decision.decision).toBe(vector.expect.decision);
    expect(decision.policyIds).toEqual(expect.arrayContaining([...vector.expect.policyIds]));
  });
});

describe('createCedarPlanPolicy', () => {
  it('refuses a policy text that does not parse (the module will not mount)', () => {
    expect(() => createCedarPlanPolicy('permit (principal, action, resource')).toThrow(
      PlanPolicyLoadError,
    );
  });
  it('refuses duplicate policy ids', () => {
    const dup = `@id("x")\npermit (principal, action, resource);\n@id("x")\npermit (principal, action, resource);`;
    expect(() => createCedarPlanPolicy(dup)).toThrow(PlanPolicyLoadError);
  });
  it('loads the platform plan policy set', () => {
    expect(() => createCedarPlanPolicy(PLAN_POLICY_SET)).not.toThrow();
  });
  it('throws on an evaluation error rather than allowing (fail closed)', () => {
    const broken = createCedarPlanPolicy(
      '@id("broken")\npermit (principal, action, resource) when { resource.missing > 0 };',
    );
    expect(() =>
      broken.evaluate(
        { userId: 'u', tenantId: 't', roles: [] },
        {
          tenantId: 't',
          planId: 'p',
          saActive: true,
          destructiveCases: 0,
          stateChangingCases: 0,
          stateChangingAuthorised: false,
        },
      ),
    ).toThrow();
  });
});
