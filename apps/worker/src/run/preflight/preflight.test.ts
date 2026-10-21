import { describe, expect, it } from 'vitest';

import { createPreflightActivities } from './activities.js';
import { buildReport, decide, executePreflight } from './aggregate.js';
import {
  FakeEgress,
  FakeNotices,
  FakeProvider,
  FakeSessions,
  MemoryRunRepo,
  REF,
  makeFacts,
  makeHarness,
  runPhase,
} from './testing.js';
import { PREFLIGHT_CHECK_IDS, type PreflightCheckResult } from './types.js';

const byId = (d: Awaited<ReturnType<typeof runPhase>>, id: string): PreflightCheckResult => {
  const c = d.report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
};

describe('preflight phase: all checks pass', () => {
  it('passes, transitions to recon, records the window end and persists the report', async () => {
    const h = makeHarness();
    const d = await runPhase(h);
    expect(d.event).toBe('preflight_passed');
    expect(d.statusReason).toBeNull();
    expect(d.report.ok).toBe(true);
    expect(d.report.checks.map((c) => c.id)).toEqual([...PREFLIGHT_CHECK_IDS]);
    expect(d.report.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(d.report.windowEndsAt).toBe('2026-01-01T18:00:00.000Z');
    expect(h.repo.report).toEqual(d.report);
  });

  it('emits started, one check event per check, and passed, plus metrics', async () => {
    const h = makeHarness();
    await runPhase(h);
    const actions = h.audit.records.map((r) => r.action);
    expect(actions[0]).toBe('preflight.started');
    expect(actions.filter((a) => a === 'preflight.check')).toHaveLength(PREFLIGHT_CHECK_IDS.length);
    expect(actions.at(-1)).toBe('preflight.passed');
    expect(h.metrics.results).toHaveLength(PREFLIGHT_CHECK_IDS.length);
    expect(h.metrics.durations).toEqual([1.5]);
  });

  it('never puts a credential reference or secret in the report or audit trail', async () => {
    const h = makeHarness();
    const d = await runPhase(h);
    const dump = JSON.stringify([d, h.audit.records]);
    expect(dump).not.toContain('secret://');
  });

  it('passes credentials to the session manager by reference only', async () => {
    const h = makeHarness();
    await runPhase(h);
    expect(h.sessions.calls.map((c) => c.credentialRef).sort()).toEqual([
      'secret://tenant/admin',
      'secret://tenant/user',
    ]);
  });
});

describe('preflight phase: hard fails', () => {
  it('fails an unverified asset immediately with ASSET_NOT_VERIFIED and touches no target', async () => {
    const h = makeHarness({
      repo: new MemoryRunRepo(
        makeFacts({
          assets: [
            { assetId: 'a1', target: 'app.example.com', verification: 'verified' },
            { assetId: 'a2', target: 'other.example.com', verification: 'pending' },
          ],
        }),
      ),
    });
    const d = await runPhase(h);
    expect(d.event).toBe('fail');
    expect(d.statusReason).toBe('preflight_failed:verifyAssetsVerified:ASSET_NOT_VERIFIED');
    expect(byId(d, 'verifyAssetsVerified').code).toBe('ASSET_NOT_VERIFIED');
    // Gates fail before any live check: no DNS, no login, no notice.
    expect(h.egress.calls).toBe(0);
    expect(h.sessions.calls).toHaveLength(0);
    expect(h.notices.calls).toBe(0);
    expect(byId(d, 'loginPerRole').code).toBe('CHECK_NOT_RUN');
  });

  it('treats a run with no assets as unverified (fail closed)', async () => {
    const d = await runPhase(makeHarness({ repo: new MemoryRunRepo(makeFacts({ assets: [] })) }));
    expect(byId(d, 'verifyAssetsVerified').code).toBe('ASSET_NOT_VERIFIED');
  });

  it.each(['unverified', 'rejected'] as const)('rejects a %s asset', async (verification) => {
    const facts = makeFacts({ assets: [{ assetId: 'a', target: 't.example.com', verification }] });
    const d = await runPhase(makeHarness({ repo: new MemoryRunRepo(facts) }));
    expect(d.statusReason).toContain('ASSET_NOT_VERIFIED');
  });

  it('ends the run expired when the SA has expired, with no traffic emitted', async () => {
    const base = makeFacts();
    const facts = makeFacts({
      authorisation: { ...base.authorisation, status: 'expired' },
    });
    const h = makeHarness({ repo: new MemoryRunRepo(facts) });
    const d = await runPhase(h);
    expect(d.event).toBe('sa_expired');
    expect(d.statusReason).toBe('preflight_failed:verifyAuthorisation:SA_EXPIRED');
    expect(h.egress.calls + h.sessions.calls.length + h.notices.calls + h.provider.calls).toBe(0);
  });

  it('detects an SA whose expiry has passed even if its status still says active', async () => {
    const base = makeFacts();
    const facts = makeFacts({
      authorisation: { ...base.authorisation, expiresAt: '2026-01-01T12:00:00.000Z' },
    });
    const d = await runPhase(makeHarness({ repo: new MemoryRunRepo(facts) }));
    expect(d.event).toBe('sa_expired');
  });

  it('fails (not expired) for a revoked SA, and for one not yet valid or still a draft', async () => {
    const base = makeFacts().authorisation;
    const revoked = await runPhase(
      makeHarness({
        repo: new MemoryRunRepo(makeFacts({ authorisation: { ...base, status: 'revoked' } })),
      }),
    );
    expect(revoked.event).toBe('fail');
    expect(revoked.statusReason).toBe('preflight_failed:verifyAuthorisation:SA_REVOKED');
    const future = await runPhase(
      makeHarness({
        repo: new MemoryRunRepo(
          makeFacts({ authorisation: { ...base, validFrom: '2026-02-01T00:00:00.000Z' } }),
        ),
      }),
    );
    expect(byId(future, 'verifyAuthorisation').code).toBe('SA_NOT_ACTIVE');
    const draft = await runPhase(
      makeHarness({
        repo: new MemoryRunRepo(makeFacts({ authorisation: { ...base, status: 'draft' } })),
      }),
    );
    expect(byId(draft, 'verifyAuthorisation').code).toBe('SA_NOT_ACTIVE');
  });

  it('fails WINDOW_CLOSED when the window is closed, not yet open, ended, or absent', async () => {
    const cases = [
      { opensAt: '2026-01-01T13:00:00.000Z', closesAt: '2026-01-01T18:00:00.000Z' },
      { opensAt: '2026-01-01T08:00:00.000Z', closesAt: '2026-01-01T12:00:00.000Z' },
      null,
    ];
    for (const window of cases) {
      const d = await runPhase(makeHarness({ repo: new MemoryRunRepo(makeFacts({ window })) }));
      expect(d.event).toBe('fail');
      expect(d.statusReason).toBe('preflight_failed:assertWindowOpen:WINDOW_CLOSED');
    }
  });

  it('records the window end even when it closes imminently', async () => {
    const window = { opensAt: '2026-01-01T10:00:00.000Z', closesAt: '2026-01-01T12:00:01.000Z' };
    const d = await runPhase(makeHarness({ repo: new MemoryRunRepo(makeFacts({ window })) }));
    expect(d.report.ok).toBe(true);
    expect(d.report.windowEndsAt).toBe('2026-01-01T12:00:01.000Z');
  });

  it('does not retry definitive failures (the activity returns, it does not throw)', async () => {
    const h = makeHarness({
      repo: new MemoryRunRepo(makeFacts({ window: null })),
    });
    const acts = createPreflightActivities(h.deps);
    await expect(acts.assertWindowOpen(REF)).resolves.toMatchObject({ status: 'fail' });
  });

  it('fails BUDGET_EXHAUSTED when a budget is exactly zero, naming the dimension', async () => {
    const facts = makeFacts({
      budgetsRemaining: { costCapUsd: 0, maxRequests: 10, maxDurationMs: 10 },
    });
    const d = await runPhase(makeHarness({ repo: new MemoryRunRepo(facts) }));
    expect(d.statusReason).toBe('preflight_failed:assertBudgetsAvailable:BUDGET_EXHAUSTED');
    expect(byId(d, 'assertBudgetsAvailable').detail).toContain('costCapUsd');
  });

  it('fails closed on a negative or non-finite remaining budget', async () => {
    for (const bad of [-1, Number.NaN]) {
      const facts = makeFacts({
        budgetsRemaining: { costCapUsd: 5, maxRequests: bad, maxDurationMs: 10 },
      });
      const d = await runPhase(makeHarness({ repo: new MemoryRunRepo(facts) }));
      expect(byId(d, 'assertBudgetsAvailable').code).toBe('BUDGET_EXHAUSTED');
    }
  });

  it('fails LOCKOUT_EXEMPTION_MISSING when roles exist and the attestation is absent', async () => {
    const base = makeFacts().authorisation;
    const facts = makeFacts({ authorisation: { ...base, lockoutExemptionAttested: false } });
    const h = makeHarness({ repo: new MemoryRunRepo(facts) });
    const d = await runPhase(h);
    expect(d.statusReason).toBe(
      'preflight_failed:assertLockoutExemption:LOCKOUT_EXEMPTION_MISSING',
    );
    expect(h.sessions.calls).toHaveLength(0);
  });

  it('does not require lockout exemption when no roles log in', async () => {
    const base = makeFacts().authorisation;
    const facts = makeFacts({
      roles: [],
      authorisation: { ...base, lockoutExemptionAttested: false },
    });
    const d = await runPhase(makeHarness({ repo: new MemoryRunRepo(facts) }));
    expect(d.report.ok).toBe(true);
  });

  it('fails when the run is missing for the tenant or not in preflight', async () => {
    const missing = await runPhase(makeHarness({ repo: new MemoryRunRepo(null) }));
    expect(missing.statusReason).toBe('preflight_failed:verifyAuthorisation:RUN_NOT_FOUND');
    const wrong = await runPhase(
      makeHarness({ repo: new MemoryRunRepo(makeFacts({ state: 'recon' })) }),
    );
    expect(wrong.statusReason).toBe('preflight_failed:verifyAuthorisation:RUN_NOT_IN_PREFLIGHT');
  });

  it('does not see another tenant run (tenant isolation)', async () => {
    const h = makeHarness();
    const acts = createPreflightActivities(h.deps);
    const r = await acts.verifyAuthorisation({
      tenantId: '0190a000-0000-7000-8000-0000000000ff',
      runId: REF.runId,
    });
    expect(r.code).toBe('RUN_NOT_FOUND');
  });
});

describe('preflight phase: roles', () => {
  it('fails naming the role when one of several logins fails (no partial auth)', async () => {
    const h = makeHarness({ sessions: new FakeSessions(['user']) });
    const d = await runPhase(h);
    expect(d.event).toBe('fail');
    expect(d.statusReason).toBe('preflight_failed:loginPerRole:ROLE_LOGIN_FAILED');
    expect(byId(d, 'loginPerRole').detail).toContain('user');
    expect(byId(d, 'loginPerRole').detail).not.toContain('admin');
  });

  it('names every failed role', async () => {
    const d = await runPhase(makeHarness({ sessions: new FakeSessions(['user', 'admin']) }));
    const detail = byId(d, 'loginPerRole').detail;
    expect(detail).toContain('user');
    expect(detail).toContain('admin');
  });

  it('strips control characters from tenant-supplied role names', async () => {
    const facts = makeFacts({ roles: [{ role: 'ad\nmin\u0000', credentialRef: 'secret://x' }] });
    const d = await runPhase(
      makeHarness({
        repo: new MemoryRunRepo(facts),
        sessions: new FakeSessions(['ad\nmin\u0000']),
      }),
    );
    expect(byId(d, 'loginPerRole').detail).toBe('login failed for role(s): admin');
  });
});

describe('preflight phase: target resolution', () => {
  const answer = (over: Record<string, unknown>) =>
    new FakeEgress((targets) =>
      targets.map((target) => ({
        target,
        inScope: true,
        resolved: true,
        addresses: ['93.184.216.34'],
        privateAllowed: false,
        ...over,
      })),
    );

  it('fails an out-of-scope target', async () => {
    const d = await runPhase(makeHarness({ egress: answer({ inScope: false }) }));
    expect(d.statusReason).toBe('preflight_failed:resolveAndScopeTargets:TARGET_OUT_OF_SCOPE');
  });

  it('fails a target the scope engine did not answer for', async () => {
    const d = await runPhase(makeHarness({ egress: new FakeEgress(() => []) }));
    expect(byId(d, 'resolveAndScopeTargets').code).toBe('TARGET_OUT_OF_SCOPE');
  });

  it('fails a target that does not resolve', async () => {
    const d = await runPhase(makeHarness({ egress: answer({ resolved: false, addresses: [] }) }));
    expect(byId(d, 'resolveAndScopeTargets').code).toBe('TARGET_UNRESOLVABLE');
  });

  it.each([
    '10.0.0.5',
    '127.0.0.1',
    '169.254.169.254',
    '::1',
    'fd00:ec2::254',
    '::ffff:10.0.0.1',
    'bogus',
  ])('fails a target resolving to %s (anti-rebinding pre-check)', async (address) => {
    const d = await runPhase(
      makeHarness({ egress: answer({ addresses: ['93.184.216.34', address] }) }),
    );
    expect(byId(d, 'resolveAndScopeTargets').code).toBe('TARGET_PRIVATE_ADDRESS');
  });

  it('admits a private address only when a scope rule explicitly allows it', async () => {
    const d = await runPhase(
      makeHarness({ egress: answer({ addresses: ['10.0.0.5'], privateAllowed: true }) }),
    );
    expect(byId(d, 'resolveAndScopeTargets').status).toBe('pass');
  });

  it.each(['grey', 'white'] as const)(
    'skips (not fails) active resolution in %s mode when the manifest supplies the surface',
    async (mode) => {
      const h = makeHarness({
        repo: new MemoryRunRepo(makeFacts({ mode, manifestSuppliesSurface: true })),
        egress: answer({ inScope: false }),
      });
      const d = await runPhase(h);
      expect(byId(d, 'resolveAndScopeTargets').status).toBe('skip');
      expect(d.report.ok).toBe(true);
      expect(h.egress.calls).toBe(0);
    },
  );

  it('still resolves in black mode even if a manifest is present', async () => {
    const h = makeHarness({
      repo: new MemoryRunRepo(makeFacts({ mode: 'black', manifestSuppliesSurface: true })),
    });
    await runPhase(h);
    expect(h.egress.calls).toBe(1);
  });
});

describe('preflight phase: SOC notice', () => {
  it('fails hard when delivery failed', async () => {
    const d = await runPhase(makeHarness({ notices: new FakeNotices('failed') }));
    expect(d.statusReason).toBe('preflight_failed:deliverSocNotice:SOC_NOTICE_FAILED');
  });

  it('does not accept a merely queued notice: retried, then failed unconfirmed', async () => {
    const notices = new FakeNotices('queued');
    const d = await runPhase(makeHarness({ notices }), 3);
    expect(notices.calls).toBe(3);
    expect(d.statusReason).toBe('preflight_failed:deliverSocNotice:SOC_NOTICE_UNCONFIRMED');
  });

  it('passes once a queued notice is confirmed on a later attempt', async () => {
    const notices = new FakeNotices('queued');
    const acts = createPreflightActivities(makeHarness({ notices }).deps);
    await expect(acts.deliverSocNotice(REF)).rejects.toThrow();
    notices.state = 'delivered';
    await expect(acts.deliverSocNotice(REF)).resolves.toMatchObject({ status: 'pass' });
  });
});

describe('preflight phase: model provider and transient errors', () => {
  it('retries a briefly unreachable provider and then passes', async () => {
    const provider = new FakeProvider(2);
    const d = await runPhase(makeHarness({ provider }), 3);
    expect(d.report.ok).toBe(true);
    expect(provider.calls).toBe(3);
  });

  it('fails after the retry policy is exhausted, without echoing the error text', async () => {
    const provider = new FakeProvider(10);
    const d = await runPhase(makeHarness({ provider }), 3);
    expect(provider.calls).toBe(3);
    expect(d.statusReason).toBe(
      'preflight_failed:assertModelProviderReachable:MODEL_PROVIDER_UNREACHABLE',
    );
    expect(JSON.stringify(d)).not.toContain('internal-host');
  });

  it('fails CHECK_UNAVAILABLE when a downstream throws persistently', async () => {
    const egress = new FakeEgress();
    egress.resolve = () => Promise.reject(new Error('boom'));
    const d = await runPhase(makeHarness({ egress }), 2);
    expect(d.statusReason).toBe('preflight_failed:resolveAndScopeTargets:CHECK_UNAVAILABLE');
  });
});

describe('preflight phase: audit of failures', () => {
  it('emits preflight.failed naming the failing check and persists the failed report', async () => {
    const h = makeHarness({ notices: new FakeNotices('failed') });
    const d = await runPhase(h);
    const last = h.audit.records.at(-1);
    expect(last?.action).toBe('preflight.failed');
    expect(last?.outcome).toBe('failure');
    expect(last?.metadata).toMatchObject({ failedCheck: 'deliverSocNotice' });
    expect(h.repo.report?.ok).toBe(false);
    expect(h.repo.report).toEqual(d.report);
  });

  it('uses stable dedupe keys so a retried finish cannot double-append', async () => {
    const h = makeHarness();
    await runPhase(h);
    const keys = h.audit.records.map((r) => r.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('executePreflight', () => {
  it('cancels siblings on the first hard fail and records them as skipped', async () => {
    let cancelled = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const report = await executePreflight(
      async (id) => {
        if (id === 'verifyAuthorisation') {
          return { id, status: 'fail', code: 'SA_REVOKED', detail: 'x' };
        }
        await gate;
        if (cancelled) throw new Error('cancelled');
        return { id, status: 'pass', detail: 'ok' };
      },
      () => {
        cancelled = true;
        release();
      },
    );
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual([
      'verifyAuthorisation',
    ]);
    expect(report.checks.find((c) => c.id === 'assertWindowOpen')?.code).toBe('CHECK_CANCELLED');
  });

  it('calls cancel exactly once even with several failures', async () => {
    let cancels = 0;
    await executePreflight(
      (id) => Promise.resolve({ id, status: 'fail', code: 'CHECK_UNAVAILABLE', detail: 'x' }),
      () => {
        cancels += 1;
      },
    );
    expect(cancels).toBe(1);
  });

  it('names the first failing check in canonical order when several fail', () => {
    const checks = PREFLIGHT_CHECK_IDS.map((id): PreflightCheckResult =>
      id === 'assertBudgetsAvailable' || id === 'verifyAssetsVerified'
        ? { id, status: 'fail', code: 'BUDGET_EXHAUSTED', detail: 'x' }
        : { id, status: 'pass', detail: 'ok' },
    );
    expect(decide(buildReport(checks)).statusReason).toBe(
      'preflight_failed:verifyAssetsVerified:BUDGET_EXHAUSTED',
    );
  });

  it('only a pass can carry a window end into the report', () => {
    const r = buildReport([
      {
        id: 'assertWindowOpen',
        status: 'fail',
        code: 'WINDOW_CLOSED',
        detail: 'x',
        windowEndsAt: 'z',
      },
    ]);
    expect(r.windowEndsAt).toBeNull();
  });
});
