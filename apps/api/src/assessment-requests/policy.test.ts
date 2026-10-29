import { describe, expect, it } from 'vitest';

import {
  AssessmentPolicyLoadError,
  ASSESSMENT_POLICY_SET,
  createCedarAssessmentPolicy,
} from './policy.js';

const TENANT = '0198f0a0-0000-7000-8000-00000000000a';
const OTHER = '0198f0a0-0000-7000-8000-00000000000b';
const OWNER = '0198f0a0-0000-7000-8000-0000000000a2';
const OTHER_USER = '0198f0a0-0000-7000-8000-0000000000a9';
const ASSET = '0198f0a0-0000-7000-8000-00000000000c';

const engine = createCedarAssessmentPolicy();
const asset = { id: ASSET, tenantId: TENANT, ownerUserIds: [OWNER] };
const who = (roles: string[], userId = OWNER, tenantId = TENANT) => ({ userId, tenantId, roles });

describe('assessment asset policy (Cedar, SCOPE-005 requirement 6)', () => {
  it('allows an appsec engineer or an org admin to act on any asset of their tenant', () => {
    expect(engine.authorize(who(['appsec_engineer'], OTHER_USER), asset)).toBe('allow');
    expect(engine.authorize(who(['org_admin'], OTHER_USER), asset)).toBe('allow');
  });

  it('allows an asset owner to act on an asset they own, and refuses one they do not own', () => {
    expect(engine.authorize(who(['asset_owner'], OWNER), asset)).toBe('allow');
    expect(engine.authorize(who(['asset_owner'], OTHER_USER), asset)).toBe('deny');
  });

  it('refuses every cross-tenant combination, even for an appsec engineer', () => {
    expect(engine.authorize(who(['appsec_engineer'], OTHER_USER, OTHER), asset)).toBe('deny');
    expect(
      engine.authorize(who(['appsec_engineer'], OTHER_USER), { ...asset, tenantId: OTHER }),
    ).toBe('deny');
  });

  it('denies by default: no role, an auditor, a developer', () => {
    expect(engine.authorize(who([]), asset)).toBe('deny');
    expect(engine.authorize(who(['auditor'], OWNER), asset)).toBe('deny');
    expect(engine.authorize(who(['developer'], OWNER), asset)).toBe('deny');
  });

  it('refuses to load a policy set that does not parse (fail closed at start-up)', () => {
    expect(() => createCedarAssessmentPolicy('permit (principal, action, resource')).toThrow(
      AssessmentPolicyLoadError,
    );
  });

  it('refuses a policy set that repeats a policy id', () => {
    const duplicated = `${ASSESSMENT_POLICY_SET}\n@id("assessment.appsec")\npermit (principal, action, resource);`;
    expect(() => createCedarAssessmentPolicy(duplicated)).toThrow(
      /duplicate policy id assessment.appsec/,
    );
  });
});
