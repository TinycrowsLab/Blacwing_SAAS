import { describe, expect, it } from 'vitest';

import { APPSEC_A, APPSEC_B, DEV_A, TENANT_A, TENANT_B, uuidOf } from './fixtures.test-helpers.js';
import { createCedarFindingPolicy, FINDING_POLICY_SET, FindingPolicyLoadError } from './policy.js';

const policy = createCedarFindingPolicy();
const finding = (status: 'confirmed' | 'suspected', tenantId = TENANT_A) => ({
  id: 'fnd_example',
  tenantId,
  status,
});
const member = (userId: string, roles: string[], tenantId = TENANT_A) => ({
  userId,
  tenantId,
  roles,
});

describe('Cedar finding read policy (F17, tenant isolation)', () => {
  it('lets a member of the tenant read a non-suspected finding', () => {
    expect(policy.allows(member(DEV_A, ['developer']), finding('confirmed'))).toBe(true);
  });

  it('refuses a suspected finding to a non-analyst role (F17 analyst-only)', () => {
    for (const role of ['developer', 'auditor', 'org_admin', 'asset_owner', 'ci_pipeline']) {
      expect(policy.allows(member(DEV_A, [role]), finding('suspected'))).toBe(false);
    }
  });

  it('lets an AppSec analyst read a suspected finding', () => {
    expect(policy.allows(member(APPSEC_A, ['appsec_engineer']), finding('suspected'))).toBe(true);
  });

  it('refuses a finding of another tenant whatever the role (cross-tenant negative)', () => {
    expect(
      policy.allows(member(APPSEC_A, ['appsec_engineer']), finding('confirmed', TENANT_B)),
    ).toBe(false);
    expect(
      policy.allows(
        member(APPSEC_B, ['appsec_engineer'], TENANT_B),
        finding('confirmed', TENANT_A),
      ),
    ).toBe(false);
  });

  it('denies when the principal has no roles at all (fail closed)', () => {
    expect(policy.allows(member(uuidOf(0xdead), []), finding('confirmed'))).toBe(false);
  });

  it('denies a suspected collection probe for a developer and allows it for an analyst', () => {
    expect(
      policy.allows(member(DEV_A, ['developer']), {
        id: '*',
        tenantId: TENANT_A,
        status: 'suspected',
      }),
    ).toBe(false);
    expect(
      policy.allows(member(APPSEC_A, ['appsec_engineer']), {
        id: '*',
        tenantId: TENANT_A,
        status: 'suspected',
      }),
    ).toBe(true);
  });

  it('refuses a policy set that does not parse (the API refuses to start)', () => {
    expect(() => createCedarFindingPolicy('permit (principal, action, resource) when {')).toThrow(
      FindingPolicyLoadError,
    );
  });

  it('refuses a policy set with a duplicate id', () => {
    const duplicated = `${FINDING_POLICY_SET}\n${FINDING_POLICY_SET}`;
    expect(() => createCedarFindingPolicy(duplicated)).toThrow(FindingPolicyLoadError);
  });
});
