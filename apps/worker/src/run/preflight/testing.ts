import { createLogger } from '@blackwing/logger';

import { createPreflightActivities, type PreflightActivityDeps } from './activities.js';
import { decide, executePreflight } from './aggregate.js';

import type {
  EgressScopeClient,
  ModelProviderProbe,
  PreflightAuditRecord,
  PreflightAuditSink,
  PreflightMetrics,
  PreflightRunFacts,
  PreflightRunRepo,
  ResolvedTarget,
  SessionLoginClient,
  SocNoticeClient,
  SocNoticeState,
} from './ports.js';
import type {
  PreflightCheckId,
  PreflightDecision,
  PreflightRef,
  PreflightReport,
} from './types.js';

// Test doubles for the preflight activities (shared by the unit tests). Not exported from the package.

const TENANT = '0190a000-0000-7000-8000-000000000001';
const RUN_ID = '0190a000-0000-7000-8000-0000000000b1';
export const REF: PreflightRef = { tenantId: TENANT, runId: RUN_ID };
const NOW = new Date('2026-01-01T12:00:00.000Z');

export function makeFacts(over: Partial<PreflightRunFacts> = {}): PreflightRunFacts {
  return {
    runId: RUN_ID,
    tenantId: TENANT,
    state: 'preflight',
    mode: 'black',
    manifestSuppliesSurface: false,
    assets: [{ assetId: 'a1', target: 'app.example.com', verification: 'verified' }],
    authorisation: {
      id: 'sa1',
      status: 'active',
      validFrom: '2025-12-01T00:00:00.000Z',
      expiresAt: '2026-06-01T00:00:00.000Z',
      lockoutExemptionAttested: true,
    },
    window: { opensAt: '2026-01-01T10:00:00.000Z', closesAt: '2026-01-01T18:00:00.000Z' },
    roles: [
      { role: 'admin', credentialRef: 'secret://tenant/admin' },
      { role: 'user', credentialRef: 'secret://tenant/user' },
    ],
    budgetsRemaining: { costCapUsd: 50, maxRequests: 1000, maxDurationMs: 3_600_000 },
    ...over,
  };
}

export class MemoryRunRepo implements PreflightRunRepo {
  report: PreflightReport | null = null;
  saves = 0;
  constructor(public facts: PreflightRunFacts | null = makeFacts()) {}
  load(tenantId: string, runId: string): Promise<PreflightRunFacts | null> {
    const f = this.facts;
    return Promise.resolve(f?.tenantId === tenantId && f.runId === runId ? f : null);
  }
  saveReport(_tenantId: string, _runId: string, report: PreflightReport): Promise<void> {
    this.report = report;
    this.saves += 1;
    return Promise.resolve();
  }
}

export class FakeEgress implements EgressScopeClient {
  calls = 0;
  constructor(
    public answer: (targets: readonly string[]) => readonly ResolvedTarget[] = (targets) =>
      targets.map((target) => ({
        target,
        inScope: true,
        resolved: true,
        addresses: ['93.184.216.34'],
        privateAllowed: false,
      })),
  ) {}
  resolve(request: { targets: readonly string[] }): Promise<readonly ResolvedTarget[]> {
    this.calls += 1;
    return Promise.resolve(this.answer(request.targets));
  }
}

export class FakeSessions implements SessionLoginClient {
  calls: { role: string; credentialRef: string }[] = [];
  constructor(public failRoles: readonly string[] = []) {}
  verifyLogin(request: { role: string; credentialRef: string }): Promise<{ ok: boolean }> {
    this.calls.push({ role: request.role, credentialRef: request.credentialRef });
    return Promise.resolve({ ok: !this.failRoles.includes(request.role) } as { ok: true });
  }
}

export class FakeNotices implements SocNoticeClient {
  calls = 0;
  constructor(public state: SocNoticeState | Error = 'delivered') {}
  ensureDelivered(): Promise<SocNoticeState> {
    this.calls += 1;
    return this.state instanceof Error ? Promise.reject(this.state) : Promise.resolve(this.state);
  }
}

export class FakeProvider implements ModelProviderProbe {
  calls = 0;
  /** Number of initial pings that fail before it recovers. */
  constructor(public failFirst = 0) {}
  ping(): Promise<void> {
    this.calls += 1;
    return this.calls <= this.failFirst
      ? Promise.reject(new Error('connect ECONNREFUSED internal-host:443'))
      : Promise.resolve();
  }
}

class MemoryAudit implements PreflightAuditSink {
  records: PreflightAuditRecord[] = [];
  append(record: PreflightAuditRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}

class MemoryMetrics implements PreflightMetrics {
  results: [string, string][] = [];
  durations: number[] = [];
  checkResult(check: string, status: string): void {
    this.results.push([check, status]);
  }
  duration(seconds: number): void {
    this.durations.push(seconds);
  }
}

export interface Harness {
  readonly repo: MemoryRunRepo;
  readonly egress: FakeEgress;
  readonly sessions: FakeSessions;
  readonly notices: FakeNotices;
  readonly provider: FakeProvider;
  readonly audit: MemoryAudit;
  readonly metrics: MemoryMetrics;
  readonly deps: PreflightActivityDeps;
}

export function makeHarness(over: Partial<Harness> = {}): Harness {
  const repo = over.repo ?? new MemoryRunRepo();
  const egress = over.egress ?? new FakeEgress();
  const sessions = over.sessions ?? new FakeSessions();
  const notices = over.notices ?? new FakeNotices();
  const provider = over.provider ?? new FakeProvider();
  const audit = over.audit ?? new MemoryAudit();
  const metrics = over.metrics ?? new MemoryMetrics();
  return {
    repo,
    egress,
    sessions,
    notices,
    provider,
    audit,
    metrics,
    deps: {
      repo,
      egress,
      sessions,
      notices,
      modelProvider: provider,
      audit,
      metrics,
      log: createLogger('preflight-test'),
      now: () => NOW,
    },
  };
}

/**
 * Runs the phase the way `PreflightWorkflow` does, with the activities called in process: transient
 * errors are retried up to `attempts` per check (Temporal's retry policy), then the check fails.
 */
export async function runPhase(h: Harness, attempts = 3): Promise<PreflightDecision> {
  const acts = createPreflightActivities(h.deps);
  await acts.startPreflight(REF);
  const report = await executePreflight(
    async (id: PreflightCheckId) => {
      let last: unknown;
      for (let i = 0; i < attempts; i += 1) {
        try {
          return await acts[id](REF);
        } catch (err) {
          last = err;
        }
      }
      throw last instanceof Error ? last : new Error('check failed');
    },
    () => undefined,
  );
  await acts.finishPreflight({ ...REF, report, durationMs: 1500 });
  return decide(report);
}
