// The pre-submit dry run (#579): read-only, every check reported, fail-closed model probe, audited, tenant-scoped.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithTenantContext } from '@blackwing/db/tenant-context';
import { dryRunDefinitions, PREFLIGHT_CHECK_IDS, type PreflightCheckId } from '@blackwing/domain';
import { ForbiddenError, NotFoundError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import {
  ADMIN_A,
  ADMIN_B,
  ASSET_UNVERIFIED_A,
  ASSET_HOST,
  ASSET_VERIFIED_A,
  AUDITOR_A,
  activeSaA,
  GRANTED_RULE,
  memoryAssessmentStore,
  memoryAssets,
  memoryHalts,
  memoryMemberships,
  memoryPreflightAudit,
  memoryStandingAuthorisations,
  NOW,
  SA_A,
  SA_EXPIRED_A,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';
import { createCedarAssessmentPolicy } from './policy.js';
import { AssessmentRequestService, type AssessmentRequestServiceDeps } from './service.js';

import type { ModelProviderProbe } from './ports.js';
import type { CreateAssessmentRequest, PreflightCheckResultView } from '@blackwing/contracts';

const READ_ONLY_IDS = dryRunDefinitions().map((definition) => definition.id);
const WRITE_OR_NOTIFY_IDS: readonly PreflightCheckId[] = ['loginPerRole', 'deliverSocNotice'];

const principal = { tenantId: TENANT_A, actorId: ADMIN_A };
const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenantId: TENANT_A, actor: { type: 'user', id: ADMIN_A } }, fn);

const draft: CreateAssessmentRequest = {
  mode: 'grey',
  objective: 'Authenticated checks of the checkout API.',
  assetIds: [ASSET_VERIFIED_A],
  saId: SA_A,
  scopeRules: { rules: [GRANTED_RULE] },
  maxIntrusiveness: 'active_safe',
  trigger: 'api',
};

const okProbe = (): ModelProviderProbe & { calls: number } => {
  const probe = {
    calls: 0,
    reachable() {
      probe.calls += 1;
      return Promise.resolve(true);
    },
  };
  return probe;
};

interface Harness {
  readonly service: AssessmentRequestService;
  readonly store: ReturnType<typeof memoryAssessmentStore>;
  readonly audit: ReturnType<typeof memoryPreflightAudit>;
  readonly halted: Set<string>;
  readonly counts: { checks: [string, string][]; dryRuns: boolean[] };
}

/** A service over the fixtures. Tests override the SA table, the probe or the caller's roles. */
function harness(
  options: Partial<AssessmentRequestServiceDeps> & {
    readonly saTable?: Parameters<typeof memoryStandingAuthorisations>[0];
    readonly roles?: Parameters<typeof memoryMemberships>[0];
  } = {},
): Harness {
  const store = memoryAssessmentStore();
  const audit = memoryPreflightAudit();
  const halted = new Set<string>();
  const counts: Harness['counts'] = { checks: [], dryRuns: [] };
  const service = new AssessmentRequestService({
    store,
    assets: memoryAssets({
      [TENANT_A]: { [ASSET_VERIFIED_A]: 'verified', [ASSET_UNVERIFIED_A]: 'unverified' },
      [TENANT_B]: { [ASSET_VERIFIED_A]: 'verified' },
    }),
    standingAuthorisations: memoryStandingAuthorisations(
      options.saTable ?? { [`${TENANT_A}:${SA_A}`]: activeSaA() },
    ),
    memberships: memoryMemberships(
      options.roles ?? {
        [TENANT_A]: { [ADMIN_A]: ['appsec_engineer'], [AUDITOR_A]: ['auditor'] },
        [TENANT_B]: { [ADMIN_B]: ['org_admin'] },
      },
    ),
    halts: memoryHalts(halted),
    policy: createCedarAssessmentPolicy(),
    metrics: {
      submitted: () => undefined,
      validationFailed: () => undefined,
      preflightCheck: (id, status) => {
        counts.checks.push([id, status]);
      },
      preflightDryRun: (ok) => {
        counts.dryRuns.push(ok);
      },
    },
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    now: () => NOW,
    preflightAudit: audit,
    targetResolver: options.targetResolver ?? { resolve: () => Promise.resolve(['203.0.113.10']) },
    ...(options.modelProbe === undefined ? {} : { modelProbe: options.modelProbe }),
  });
  return { service, store, audit, halted, counts };
}

/** Creates a draft for the tenant A admin and returns its public id. */
async function createDraft(h: Harness, body: CreateAssessmentRequest = draft): Promise<string> {
  const view = await inTenant(() => h.service.create(principal, body));
  return view.body.id;
}

const resultOf = (
  report: { results: readonly PreflightCheckResultView[] },
  id: string,
): PreflightCheckResultView | undefined => report.results.find((result) => result.id === id);

afterEach(() => {
  vi.useRealTimers();
});

describe('AssessmentRequestService.dryRun: read-only report', () => {
  it('fails resolveAndScopeTargets blocking when the host does not resolve, and sends no request', async () => {
    const resolved: string[] = [];
    const h = harness({
      modelProbe: okProbe(),
      targetResolver: {
        resolve: (host) => {
          resolved.push(host);
          return Promise.reject(new Error('ENOTFOUND'));
        },
      },
    });
    const id = await createDraft(h);
    const report = await inTenant(() => h.service.dryRun(principal, id));
    expect(report.ok).toBe(false);
    expect(report.blockingFailures).toContain('resolveAndScopeTargets');
    expect(resolved).toEqual([ASSET_HOST]);
    expect(h.audit.events).toHaveLength(1);
  });

  it('reports every read-only check and none that logs in or notifies', async () => {
    const h = harness({ modelProbe: okProbe() });
    const id = await createDraft(h);
    const report = await inTenant(() => h.service.dryRun(principal, id));
    expect(report.dryRun).toBe(true);
    expect(report.results.map((result) => result.id)).toEqual([...READ_ONLY_IDS].sort());
    for (const write of WRITE_OR_NOTIFY_IDS) {
      expect(report.results.map((result) => result.id)).not.toContain(write);
    }
    expect(report.results.map((result) => result.id)).toHaveLength(READ_ONLY_IDS.length);
    expect(READ_ONLY_IDS).toHaveLength(PREFLIGHT_CHECK_IDS.length - WRITE_OR_NOTIFY_IDS.length);
  });

  it('answers ok when every blocking read-only check passes', async () => {
    const h = harness({ modelProbe: okProbe() });
    const id = await createDraft(h);
    const report = await inTenant(() => h.service.dryRun(principal, id));
    expect(report.ok).toBe(true);
    expect(report.blockingFailures).toEqual([]);
    expect(resultOf(report, 'assertLockoutExemption')).toMatchObject({ status: 'skip' });
    expect(resultOf(report, 'assertWindowOpen')).toMatchObject({
      status: 'pass',
      evidence: { windowEndsAt: '2027-01-01T00:00:00.000Z' },
    });
  });

  it('never changes the request and never calls the provider more than once', async () => {
    const probe = okProbe();
    const h = harness({ modelProbe: probe });
    const id = await createDraft(h);
    const before = [...h.store.rows.values()].map((row) => ({ ...row }));
    await inTenant(() => h.service.dryRun(principal, id));
    const after = [...h.store.rows.values()];
    expect(after).toEqual(before);
    expect(after[0]?.status).toBe('draft');
    expect(probe.calls).toBe(1);
  });

  it('writes one dry-run audit event with the verdict and no secret', async () => {
    const h = harness({ modelProbe: okProbe() });
    const id = await createDraft(h);
    await inTenant(() => h.service.dryRun(principal, id));
    expect(h.audit.events).toHaveLength(1);
    expect(h.audit.events[0]).toMatchObject({
      tenantId: TENANT_A,
      action: 'scope.preflight.dry_run',
      actor: { type: 'user', id: ADMIN_A },
      target: { type: 'assessment_request', publicId: id },
      outcome: 'success',
      metadata: { ok: true, blockingFailures: [] },
    });
    expect(JSON.stringify(h.audit.events)).not.toMatch(/secret|token|password/i);
    expect(h.counts.dryRuns).toEqual([true]);
  });

  it('records one metric per check, by id and status', async () => {
    const h = harness({ modelProbe: okProbe() });
    const id = await createDraft(h);
    await inTenant(() => h.service.dryRun(principal, id));
    expect(h.counts.checks.map(([checkId]) => checkId).sort()).toEqual([...READ_ONLY_IDS].sort());
    expect(h.counts.checks.find(([checkId]) => checkId === 'assertLockoutExemption')).toEqual([
      'assertLockoutExemption',
      'skip',
    ]);
  });
});

describe('AssessmentRequestService.dryRun: blocking failures', () => {
  it('fails verifyAssetsVerified for an unverified asset, with remediation', async () => {
    const h = harness({ modelProbe: okProbe() });
    const id = await createDraft(h, { ...draft, assetIds: [ASSET_VERIFIED_A, ASSET_UNVERIFIED_A] });
    const report = await inTenant(() => h.service.dryRun(principal, id));
    expect(report.ok).toBe(false);
    expect(report.blockingFailures).toEqual(['verifyAssetsVerified']);
    expect(resultOf(report, 'verifyAssetsVerified')).toMatchObject({
      status: 'fail',
      code: 'ASSET_NOT_VERIFIED',
      severity: 'blocking',
    });
    expect(resultOf(report, 'verifyAssetsVerified')?.remediation).toContain('verification');
    expect(h.audit.events[0]?.metadata).toMatchObject({
      ok: false,
      blockingFailures: ['verifyAssetsVerified'],
    });
  });

  it('fails assertWindowOpen when the standing authorisation window has not opened', async () => {
    const h = harness({
      modelProbe: okProbe(),
      saTable: {
        [`${TENANT_A}:${SA_A}`]: {
          ...activeSaA(),
          validFrom: new Date('2026-11-01T00:00:00.000Z'),
        },
      },
    });
    const id = await createDraft(h);
    const report = await inTenant(() => h.service.dryRun(principal, id));
    expect(report.ok).toBe(false);
    expect(report.blockingFailures).toContain('assertWindowOpen');
    expect(resultOf(report, 'assertWindowOpen')).toMatchObject({
      status: 'fail',
      code: 'WINDOW_CLOSED',
    });
  });

  it('fails assertWindowOpen and verifyAuthorisation for an expired standing authorisation', async () => {
    const h = harness({
      modelProbe: okProbe(),
      saTable: {
        [`${TENANT_A}:${SA_A}`]: {
          ...activeSaA(),
          id: SA_EXPIRED_A,
          validFrom: new Date('2025-01-01T00:00:00.000Z'),
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      },
    });
    const id = await createDraft(h);
    const report = await inTenant(() => h.service.dryRun(principal, id));
    expect(report.blockingFailures).toEqual(
      expect.arrayContaining(['assertWindowOpen', 'verifyAuthorisation']),
    );
    expect(resultOf(report, 'verifyAuthorisation')).toMatchObject({ code: 'SA_EXPIRED' });
  });

  it('fails verifyAuthorisation with SA_REQUIRED for a request without a standing authorisation', async () => {
    const h = harness({ modelProbe: okProbe() });
    const withoutSa: CreateAssessmentRequest = { ...draft };
    delete withoutSa.saId;
    const id = await createDraft(h, withoutSa);
    const report = await inTenant(() => h.service.dryRun(principal, id));
    expect(report.ok).toBe(false);
    expect(resultOf(report, 'verifyAuthorisation')).toMatchObject({ code: 'SA_REQUIRED' });
    expect(resultOf(report, 'assertWindowOpen')).toMatchObject({ code: 'WINDOW_CLOSED' });
  });
});

describe('AssessmentRequestService.dryRun: model provider probe (fail closed)', () => {
  it('fails closed when no probe is configured for the deployment', async () => {
    const h = harness();
    const id = await createDraft(h);
    const report = await inTenant(() => h.service.dryRun(principal, id));
    expect(report.ok).toBe(false);
    expect(resultOf(report, 'assertModelProviderReachable')).toMatchObject({
      status: 'fail',
      code: 'MODEL_PROVIDER_UNREACHABLE',
    });
  });

  it('fails as unreachable when the provider answers false', async () => {
    const h = harness({ modelProbe: { reachable: () => Promise.resolve(false) } });
    const id = await createDraft(h);
    const report = await inTenant(() => h.service.dryRun(principal, id));
    expect(resultOf(report, 'assertModelProviderReachable')).toMatchObject({
      code: 'MODEL_PROVIDER_UNREACHABLE',
    });
  });

  it('fails as unreachable when the probe throws, and the other checks still report', async () => {
    const h = harness({
      modelProbe: {
        reachable: () => Promise.reject(new Error('dns failure at 10.0.0.5 key=sk-123')),
      },
    });
    const id = await createDraft(h);
    const report = await inTenant(() => h.service.dryRun(principal, id));
    expect(resultOf(report, 'assertModelProviderReachable')).toMatchObject({
      status: 'fail',
      code: 'MODEL_PROVIDER_UNREACHABLE',
    });
    expect(JSON.stringify(report)).not.toContain('sk-123');
    expect(report.results).toHaveLength(READ_ONLY_IDS.length);
    expect(resultOf(report, 'verifyAuthorisation')?.status).toBe('pass');
  });

  it('times out a probe that never answers, as PREFLIGHT_PROVIDER_TIMEOUT', async () => {
    vi.useFakeTimers();
    const h = harness({ modelProbe: { reachable: () => new Promise<boolean>(() => undefined) } });
    const id = await createDraft(h);
    const pending = inTenant(() => h.service.dryRun(principal, id));
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await pending;
    expect(resultOf(report, 'assertModelProviderReachable')).toMatchObject({
      status: 'fail',
      code: 'PREFLIGHT_PROVIDER_TIMEOUT',
    });
    expect(report.ok).toBe(false);
  });
});

describe('AssessmentRequestService.dryRun: refusals and tenant isolation', () => {
  it('answers 409 for a halted tenant, and writes no audit event', async () => {
    const h = harness({ modelProbe: okProbe() });
    const id = await createDraft(h);
    h.halted.add(TENANT_A);
    await expect(inTenant(() => h.service.dryRun(principal, id))).rejects.toMatchObject({
      problemCode: 'tenant_halted',
    });
    expect(h.audit.events).toEqual([]);
    expect(h.counts.dryRuns).toEqual([]);
  });

  it('refuses a caller without assessment:create, and writes no audit event', async () => {
    const h = harness({ modelProbe: okProbe() });
    const id = await createDraft(h);
    await expect(
      inTenant(() => h.service.dryRun({ tenantId: TENANT_A, actorId: AUDITOR_A }, id)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.audit.events).toEqual([]);
  });

  it('answers a foreign tenant request as not found, and evaluates nothing', async () => {
    const h = harness({ modelProbe: okProbe() });
    const id = await createDraft(h);
    const foreign = { tenantId: TENANT_B, actorId: ADMIN_B };
    await expect(
      runWithTenantContext({ tenantId: TENANT_B, actor: { type: 'user', id: ADMIN_B } }, () =>
        h.service.dryRun(foreign, id),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(h.audit.events).toEqual([]);
    expect(h.counts.checks).toEqual([]);
  });
});
