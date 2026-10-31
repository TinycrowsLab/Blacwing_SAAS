// The dry-run checks (#579): one per read-only catalogue id, and each verdict follows the submit gate's findings.

import { describe, expect, it } from 'vitest';

import { dryRunDefinitions } from '@blackwing/domain';

import {
  DRY_RUN_CHECKS,
  type DryRunContext,
  type DryRunFacts,
  PREFLIGHT_NOT_RUN_CODE,
  PREFLIGHT_PROVIDER_TIMEOUT_CODE,
  PREFLIGHT_PROVIDER_UNREACHABLE_CODE,
} from './preflight.js';

import type { StandingAuthorisationFact } from './ports.js';
import type { SubmitFailure } from './submit-checks.js';

const NOW = new Date('2026-10-29T10:00:00.000Z');

const sa: StandingAuthorisationFact = {
  id: '0198f0a0-0000-7000-8000-0000000000f1',
  status: 'active',
  validFrom: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  assetIds: [],
  scopeRules: { rules: [] },
  maxIntrusiveness: 'active_safe',
  defaultBudgets: { costCapUsd: 10, maxRequests: 10_000, maxDurationMs: 7_200_000 },
};

const okResolver = { resolve: () => Promise.resolve(['203.0.113.10']) };

function ctx(
  overrides: Partial<DryRunFacts> & {
    readonly modelProbe?: DryRunContext['modelProbe'];
    readonly resolver?: DryRunContext['resolver'];
  } = {},
): DryRunContext {
  const { modelProbe, resolver, ...facts } = overrides;
  return {
    facts: {
      now: NOW,
      failures: [],
      sa,
      assetCount: 1,
      assetHosts: [['app.example.test']],
      ...facts,
    },
    modelProbe,
    resolver: resolver ?? okResolver,
  };
}

const failure = (code: SubmitFailure['code']): SubmitFailure => ({
  code,
  path: 'x',
  message: `${code} message`,
});

const probe = (answer: () => Promise<boolean>) => ({ reachable: answer });

describe('dry-run check registry', () => {
  it('has exactly one check per read-only catalogue id', () => {
    expect(Object.keys(DRY_RUN_CHECKS).sort()).toEqual(
      dryRunDefinitions()
        .map((definition) => definition.id)
        .sort(),
    );
  });
});

describe('dry-run verdicts follow the submit gate findings', () => {
  it('passes every blocking check for a clean, open, verified request with a reachable provider', async () => {
    const context = ctx({ modelProbe: probe(() => Promise.resolve(true)) });
    for (const id of [
      'verifyAuthorisation',
      'resolveAndScopeTargets',
      'verifyAssetsVerified',
      'assertWindowOpen',
      'assertBudgetsAvailable',
      'assertModelProviderReachable',
    ] as const) {
      expect((await DRY_RUN_CHECKS[id](context)).status, id).toBe('pass');
    }
  });

  it('maps an authorisation failure to verifyAuthorisation with its code and message', async () => {
    const result = await DRY_RUN_CHECKS.verifyAuthorisation(
      ctx({ failures: [failure('SA_EXPIRED')] }),
    );
    expect(result).toMatchObject({
      status: 'fail',
      code: 'SA_EXPIRED',
      detail: 'SA_EXPIRED message',
    });
  });

  it('maps a scope mismatch to resolveAndScopeTargets, not to authorisation', async () => {
    const context = ctx({ failures: [failure('SA_SCOPE_MISMATCH')] });
    expect((await DRY_RUN_CHECKS.resolveAndScopeTargets(context)).status).toBe('fail');
    expect((await DRY_RUN_CHECKS.verifyAuthorisation(context)).status).toBe('pass');
  });

  it('reports an exceeded budget as a failure of assertBudgetsAvailable', async () => {
    const result = await DRY_RUN_CHECKS.assertBudgetsAvailable(
      ctx({ failures: [failure('BUDGET_EXCEEDS_SA')] }),
    );
    expect(result).toMatchObject({ status: 'fail', code: 'BUDGET_EXCEEDS_SA' });
  });

  it('reports the lockout exemption as not run, which never blocks ok', async () => {
    expect(await DRY_RUN_CHECKS.assertLockoutExemption(ctx())).toMatchObject({
      status: 'skip',
      code: PREFLIGHT_NOT_RUN_CODE,
    });
  });

  it('closes the window before the authorisation starts, and at its end', async () => {
    const early = ctx();
    const early2 = {
      ...early,
      facts: { ...early.facts, now: new Date('2025-12-31T23:59:59.000Z') },
    };
    const late = { ...early, facts: { ...early.facts, now: new Date('2027-01-01T00:00:00.000Z') } };
    expect(await DRY_RUN_CHECKS.assertWindowOpen(early2)).toMatchObject({
      status: 'fail',
      code: 'WINDOW_CLOSED',
    });
    expect(await DRY_RUN_CHECKS.assertWindowOpen(late)).toMatchObject({
      status: 'fail',
      code: 'WINDOW_CLOSED',
    });
  });

  it('reports the window end as evidence when open', async () => {
    expect(await DRY_RUN_CHECKS.assertWindowOpen(ctx())).toMatchObject({
      status: 'pass',
      evidence: { windowEndsAt: '2027-01-01T00:00:00.000Z' },
    });
  });

  it('closes the window when there is no standing authorisation', async () => {
    expect(await DRY_RUN_CHECKS.assertWindowOpen(ctx({ sa: undefined }))).toMatchObject({
      status: 'fail',
      code: 'WINDOW_CLOSED',
    });
  });
});

describe('dry-run model provider probe', () => {
  it('fails closed without a probe', async () => {
    expect(await DRY_RUN_CHECKS.assertModelProviderReachable(ctx())).toMatchObject({
      status: 'fail',
      code: PREFLIGHT_PROVIDER_UNREACHABLE_CODE,
    });
  });

  it('fails as unreachable when the provider answers false', async () => {
    expect(
      await DRY_RUN_CHECKS.assertModelProviderReachable(
        ctx({ modelProbe: probe(() => Promise.resolve(false)) }),
      ),
    ).toMatchObject({ status: 'fail', code: PREFLIGHT_PROVIDER_UNREACHABLE_CODE });
  });

  it('fails as unreachable when the probe rejects, without echoing the error', async () => {
    const result = await DRY_RUN_CHECKS.assertModelProviderReachable(
      ctx({ modelProbe: probe(() => Promise.reject(new Error('internal host secret'))) }),
    );
    expect(result).toMatchObject({ status: 'fail', code: PREFLIGHT_PROVIDER_UNREACHABLE_CODE });
    expect(result.detail).not.toContain('secret');
  });

  it('times out a probe that does not answer in time, as PREFLIGHT_PROVIDER_TIMEOUT', async () => {
    const result = await DRY_RUN_CHECKS.assertModelProviderReachable(
      ctx({ modelProbe: probe(() => new Promise<boolean>(() => undefined)) }),
    );
    expect(result).toMatchObject({ status: 'fail', code: PREFLIGHT_PROVIDER_TIMEOUT_CODE });
  });
});

describe('dry-run DNS check (resolveAndScopeTargets, #579)', () => {
  it('resolves each host once and pins the first address as evidence', async () => {
    const calls: string[] = [];
    const resolver = {
      resolve: (host: string) => {
        calls.push(host);
        return Promise.resolve(['203.0.113.10', '203.0.113.11']);
      },
    };
    const result = await DRY_RUN_CHECKS.resolveAndScopeTargets(
      ctx({ assetHosts: [['app.example.test'], ['app.example.test']], resolver }),
    );
    expect(result.status).toBe('pass');
    expect(calls).toEqual(['app.example.test']);
    expect(result.evidence).toEqual({
      pinnedHost: 'app.example.test',
      pinnedAddress: '203.0.113.10',
      hostsResolved: 1,
    });
  });

  it('fails with the host when it does not resolve (rejection)', async () => {
    const resolver = { resolve: () => Promise.reject(new Error('ENOTFOUND internal-db.corp')) };
    const result = await DRY_RUN_CHECKS.resolveAndScopeTargets(ctx({ resolver }));
    expect(result).toMatchObject({ status: 'fail', code: 'TARGET_UNRESOLVABLE' });
    expect(result.detail).toContain('app.example.test');
    expect(result.detail).not.toContain('ENOTFOUND');
  });

  it('fails when the resolver returns no address', async () => {
    const resolver = { resolve: () => Promise.resolve([]) };
    const result = await DRY_RUN_CHECKS.resolveAndScopeTargets(ctx({ resolver }));
    expect(result).toMatchObject({ status: 'fail', code: 'TARGET_UNRESOLVABLE' });
  });

  it('fails closed when an asset has no hostname to resolve', async () => {
    const result = await DRY_RUN_CHECKS.resolveAndScopeTargets(ctx({ assetHosts: [[]] }));
    expect(result).toMatchObject({ status: 'fail', code: 'TARGET_UNRESOLVABLE' });
  });

  it('does not resolve anything when the scope already fails', async () => {
    let looked = false;
    const resolver = {
      resolve: () => {
        looked = true;
        return Promise.resolve(['203.0.113.10']);
      },
    };
    const result = await DRY_RUN_CHECKS.resolveAndScopeTargets(
      ctx({ failures: [failure('SA_SCOPE_MISMATCH')], resolver }),
    );
    expect(result.status).toBe('fail');
    expect(looked).toBe(false);
  });
});
