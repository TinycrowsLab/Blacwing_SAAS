import { describe, expect, it } from 'vitest';

import { assertLabScope } from './scope-lab.js';
import { isScopeRuleError, parseScopeRules, type ScopeRules } from './scope.js';

interface LabAssetFacts {
  readonly environment: string;
  readonly verificationStatus: string;
  readonly verificationMethod: string | null;
}

const LAB = '172.30.250.0/24';
const devAsset: LabAssetFacts = {
  environment: 'dev',
  verificationStatus: 'verified',
  verificationMethod: 'manual_letter',
};

function rules(cidr: string | null): ScopeRules {
  const cidrRule = cidr === null ? [] : [{ effect: 'include', cidr, ports: [3000] }];
  return parseScopeRules({
    rules: [{ effect: 'include', host: 'juice-shop', ports: [3000] }, ...cidrRule],
  });
}

function decide(
  cidr: string | null,
  overrides: { env?: string; asset?: Partial<LabAssetFacts>; labNetworks?: string[] } = {},
) {
  return assertLabScope({
    env: overrides.env ?? 'dev',
    asset: { ...devAsset, ...overrides.asset },
    labNetworks: overrides.labNetworks ?? [LAB],
    rules: rules(cidr),
  });
}

/** The error `fn` throws, or `undefined` when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function refusedWith(fn: () => unknown): boolean {
  return isScopeRuleError(thrownBy(fn));
}

describe('assertLabScope (#880)', () => {
  it('admits a lab-network rule in dev for a dev-attested asset and counts it', () => {
    const decision = decide(LAB);
    expect(decision.privateRuleCount).toBe(1);
    expect(decision.labNetworks).toEqual([LAB]);
  });

  it('admits in test too, and passes rules that name no private range', () => {
    expect(decide(LAB, { env: 'test' }).privateRuleCount).toBe(1);
    expect(decide(null).privateRuleCount).toBe(0);
    expect(decide('93.184.216.34/32', { labNetworks: [LAB] }).privateRuleCount).toBe(0);
  });

  it('refuses a private-range rule outside dev and test', () => {
    for (const env of ['staging', 'production', '', 'DEV']) {
      expect(
        refusedWith(() => decide(LAB, { env })),
        `env ${env}`,
      ).toBe(true);
    }
  });

  it('refuses unless the asset is verified through the dev attest path', () => {
    expect(refusedWith(() => decide(LAB, { asset: { verificationStatus: 'pending' } }))).toBe(true);
    expect(refusedWith(() => decide(LAB, { asset: { verificationMethod: null } }))).toBe(true);
    expect(refusedWith(() => decide(LAB, { asset: { environment: 'prod' } }))).toBe(true);
    expect(refusedWith(() => decide(LAB, { asset: { environment: 'test' } }))).toBe(true);
  });

  it('refuses when no lab network is supplied', () => {
    expect(refusedWith(() => decide(LAB, { labNetworks: [] }))).toBe(true);
  });

  it('refuses a rule outside the lab, a wider range, and public or broad ranges', () => {
    for (const cidr of [
      '172.30.251.0/24',
      '172.30.0.0/16',
      '10.0.0.0/8',
      '100.64.0.0/10',
      '0.0.0.0/0',
      '::/0',
    ]) {
      expect(
        refusedWith(() => decide(cidr)),
        cidr,
      ).toBe(true);
    }
  });

  it('admits a single host inside the lab', () => {
    expect(decide('172.30.250.7/32').privateRuleCount).toBe(1);
  });

  it('refuses loopback, link-local and metadata, even when the lab network names them', () => {
    for (const cidr of [
      '127.0.0.1/32',
      '127.0.0.0/8',
      '::1/128',
      '169.254.169.254/32',
      'fe80::1/128',
    ]) {
      expect(
        refusedWith(() => decide(cidr)),
        cidr,
      ).toBe(true);
      expect(
        refusedWith(() => decide(cidr, { labNetworks: ['127.0.0.0/8'] })),
        cidr,
      ).toBe(true);
    }
    expect(refusedWith(() => decide(LAB, { labNetworks: ['169.254.0.0/16'] }))).toBe(true);
  });

  it('refuses a public network offered as a lab', () => {
    expect(refusedWith(() => decide('93.184.216.0/24', { labNetworks: ['93.184.216.0/24'] }))).toBe(
      true,
    );
    expect(refusedWith(() => decide(LAB, { labNetworks: ['not-a-cidr'] }))).toBe(true);
  });

  it('accepts an IPv6 unique-local lab network', () => {
    expect(decide('fd00:30::1/128', { labNetworks: ['fd00:30::/64'] }).privateRuleCount).toBe(1);
    expect(refusedWith(() => decide('fd00:31::1/128', { labNetworks: ['fd00:30::/64'] }))).toBe(
      true,
    );
  });

  it('ignores exclude rules and host-only rules', () => {
    const doc = parseScopeRules({
      rules: [
        { effect: 'include', host: 'app.example.test' },
        { effect: 'exclude', cidr: '10.0.0.0/8' },
      ],
    });
    expect(
      assertLabScope({ env: 'production', asset: devAsset, labNetworks: [], rules: doc }),
    ).toEqual({
      privateRuleCount: 0,
      labNetworks: [],
    });
  });

  it('a refused rule set names the offending rule without any target value', () => {
    const error = thrownBy(() => decide('10.0.0.0/8'));
    expect(isScopeRuleError(error)).toBe(true);
    expect((error as Error).message).toContain('rules.1');
    expect((error as Error).message).not.toContain('10.0.0.0');
  });
});

describe('dev attest path', () => {
  it('requires dev, verified and a method', () => {
    expect(refusedWith(() => decide(LAB, { asset: { environment: 'staging' } }))).toBe(true);
    expect(refusedWith(() => decide(LAB, { asset: { verificationStatus: 'rejected' } }))).toBe(
      true,
    );
    expect(refusedWith(() => decide(LAB, { asset: { verificationMethod: null } }))).toBe(true);
    expect(decide(LAB).privateRuleCount).toBe(1);
  });
});
