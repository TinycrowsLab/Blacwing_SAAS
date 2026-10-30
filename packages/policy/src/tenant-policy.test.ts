import { isAuthorized } from '@cedar-policy/cedar-wasm/nodejs';
import { describe, expect, it } from 'vitest';

import { baselineDigest, loadBaseline, type Baseline } from './baseline.js';
import {
  assembleEffectivePolicySet,
  canonicalPolicySource,
  policySourceSha256,
} from './tenant-policy.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('canonicalPolicySource and policySourceSha256', () => {
  it('normalises line endings, trailing whitespace and trailing blank lines', () => {
    const a = 'permit (principal, action, resource);\n';
    const b = 'permit (principal, action, resource);   \r\n\r\n\n';
    expect(canonicalPolicySource(b)).toBe(a);
    expect(policySourceSha256(b)).toBe(policySourceSha256(a));
  });

  it('keeps a different policy text under a different digest', () => {
    expect(policySourceSha256('permit (principal, action, resource);')).not.toBe(
      policySourceSha256('forbid (principal, action, resource);'),
    );
  });

  it('gives the empty set a stable digest (the first version of every tenant)', () => {
    expect(canonicalPolicySource('')).toBe('');
    expect(canonicalPolicySource(' \n\n')).toBe('');
    expect(policySourceSha256('')).toBe(EMPTY_SHA256);
  });

  it('produces a 64 character lowercase hex digest', () => {
    expect(policySourceSha256('permit (principal, action, resource);')).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('assembleEffectivePolicySet', () => {
  const tenant = {
    version: 3,
    sha256: policySourceSha256('permit (principal, action, resource);'),
    cedarSource: 'permit (principal, action, resource);',
  };

  it('places the baseline first and the tenant active version second', () => {
    const effective = assembleEffectivePolicySet(tenant);
    expect(Object.keys(effective)).toEqual(['baseline', 'tenant']);
    expect(effective.baseline.sha256).toBe(baselineDigest(loadBaseline()));
    expect(effective.tenant).toEqual({
      version: '3',
      sha256: tenant.sha256,
      source: 'permit (principal, action, resource);\n',
    });
  });

  it('yields baseline-only (never empty) for a tenant with no active version', () => {
    const effective = assembleEffectivePolicySet(null);
    expect(effective.tenant).toBeNull();
    expect(effective.baseline.source.length).toBeGreaterThan(0);
  });

  it('lets a tenant permit never escape a baseline forbid through the effective set', () => {
    const floor: Baseline = {
      files: [
        {
          file: 'floor.cedar',
          source: '@id("baseline.floor")\nforbid (principal, action, resource);',
        },
      ],
      policies: [],
    };
    const allow = {
      version: 1,
      sha256: policySourceSha256('@id("tenant.allow")\npermit (principal, action, resource);'),
      cedarSource: '@id("tenant.allow")\npermit (principal, action, resource);',
    };
    const request = {
      principal: { type: 'User', id: 'u' },
      action: { type: 'Action', id: 'run' },
      resource: { type: 'Tenant', id: 't' },
      context: {},
      entities: [],
    };
    const decide = (tenantRef: typeof allow | null): string => {
      const effective = assembleEffectivePolicySet(tenantRef, floor);
      const staticPolicies: Record<string, string> = {
        'baseline.floor': effective.baseline.source,
      };
      if (effective.tenant !== null) staticPolicies['tenant.allow'] = effective.tenant.source;
      const answer = isAuthorized({ ...request, policies: { staticPolicies } });
      if (answer.type !== 'success') throw new Error('cedar evaluation failed');
      return answer.response.decision;
    };
    expect(decide(allow)).toBe('deny');
    expect(decide(null)).toBe('deny');
  });
});
