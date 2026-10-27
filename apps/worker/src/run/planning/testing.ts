import { createLogger } from '@blackwing/logger';

import { createPlanningActivities, type PlanningActivityDeps } from './activities.js';

import type {
  Gate1DecisionRecord,
  Gate1Permissions,
  GateDecisions,
  PlannerRequest,
  PlannerSessions,
  PlanningAuditRecord,
  PlanningAuditSink,
  PlanningMetrics,
  PlanningRunFacts,
  PlanningRunState,
  PlanningSa,
  PlanStore,
  RunEnvelopeRecord,
  RunEnvelopes,
  StandingAuthorisations,
  StoredPlan,
} from './ports.js';
import type { PlanningRef } from './types.js';
import type { Pager } from '../postexec/ports.js';
import type { PlannedTestCase } from '@blackwing/contracts';
import type { RunStatus } from '@blackwing/domain';

// Test doubles for the planning activities (shared by the unit and integration tests). Not exported
// from the package.

export const REF: PlanningRef = {
  tenantId: '0190a000-0000-7000-8000-000000000001',
  runId: '0190a000-0000-7000-8000-0000000000b1',
};
export const REQUESTER = 'user-requester';
export const APPROVER = 'user-approver';
export const SA_ID = '0190a000-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-01-01T12:00:00.000Z');

/** When Gate 1 was requested in tests: the fixed clock. */
export const REQUESTED_AT = NOW.toISOString();

const FUTURE = '2026-06-01T00:00:00.000Z';
const PAST = '2025-12-01T00:00:00.000Z';

/** A valid, in-envelope `active_safe` case; override fields per test. */
export function testCase(over: Partial<PlannedTestCase> = {}): PlannedTestCase {
  return {
    class: 'active_safe',
    title: 'Unauthenticated admin access',
    refs: { owasp: ['A01:2021'], wstg: ['WSTG-ATHZ-02'], asvs: ['V4.1.1'] },
    cweCandidates: ['CWE-284'],
    targets: ['https://app.example.test/admin'],
    roles: ['anonymous'],
    budget: { maxRequests: 100, maxRps: 5, maxConcurrency: 2, maxBytes: 1_000_000 },
    oracle: { type: 'response.status', params: { expected: 403 } },
    negativeControl: { type: 'response.status', params: { expected: 200 } },
    ...over,
  };
}

export function sa(over: Partial<PlanningSa> = {}): PlanningSa {
  return {
    id: SA_ID,
    status: 'active',
    expiresAt: FUTURE,
    maxIntrusiveness: 'state_changing',
    preApprovedTestClasses: ['passive', 'active_safe'],
    defaultBudgets: { costCapUsd: 50, maxRequests: 1000, maxDurationMs: 3_600_000 },
    ...over,
  };
}

export const EXPIRED_AT = PAST;

export class MemoryRunState implements PlanningRunState {
  facts: PlanningRunFacts;
  failNextSave = false;

  constructor(state: RunStatus['state'] = 'planning', requestedBy: string | null = REQUESTER) {
    this.facts = {
      status: { state, version: 3 } as RunStatus,
      requestedBy,
      envelopeValid: false,
      saId: SA_ID,
      runManifest: { 'planner.prompt': 'sha256:abc' },
    };
  }

  get state(): RunStatus['state'] {
    return this.facts.status.state;
  }

  load(): Promise<PlanningRunFacts | null> {
    return Promise.resolve(this.facts);
  }

  save(_t: string, _r: string, expectedVersion: number, next: RunStatus): Promise<boolean> {
    if (this.failNextSave || expectedVersion !== this.facts.status.version) {
      this.failNextSave = false;
      return Promise.resolve(false);
    }
    this.facts = { ...this.facts, status: next };
    return Promise.resolve(true);
  }
}

export class MemorySas implements StandingAuthorisations {
  constructor(public current: PlanningSa | null = sa()) {}

  load(): Promise<PlanningSa | null> {
    return Promise.resolve(this.current);
  }
}

interface MemoryPlan extends StoredPlan {
  readonly round: number;
  readonly status: 'proposed' | 'frozen' | 'rejected';
  readonly caseStatus: 'proposed' | 'approved';
}

export class MemoryPlans implements PlanStore {
  readonly plans: MemoryPlan[] = [];

  save(request: { round: number; testCases: readonly PlannedTestCase[] }): Promise<{
    planId: string;
    version: number;
    created: boolean;
  }> {
    const existing = this.plans.find((p) => p.round === request.round);
    if (existing !== undefined) {
      return Promise.resolve({
        planId: existing.planId,
        version: existing.version,
        created: false,
      });
    }
    const version = this.plans.length + 1;
    const planId = `plan-${String(version)}`;
    this.plans.push({
      planId,
      version,
      frozen: false,
      testCases: request.testCases,
      round: request.round,
      status: 'proposed',
      caseStatus: 'proposed',
    });
    return Promise.resolve({ planId, version, created: true });
  }

  latest(): Promise<StoredPlan | null> {
    return Promise.resolve(this.plans.at(-1) ?? null);
  }

  /** A concurrent edit while Gate 1 waits: a new version supersedes the one being reviewed. */
  edit(): void {
    const last = this.plans.at(-1);
    if (last === undefined) return;
    this.plans.push({
      ...last,
      planId: `plan-${String(last.version + 1)}`,
      version: last.version + 1,
      round: last.round,
    });
  }

  freeze(
    _t: string,
    _r: string,
    planId: string,
    expectedVersion: number,
  ): Promise<'frozen' | 'conflict'> {
    const index = this.plans.findIndex((p) => p.planId === planId);
    const plan = this.plans[index];
    if (plan?.version !== expectedVersion || plan.version !== this.plans.length) {
      return Promise.resolve('conflict');
    }
    this.plans[index] = { ...plan, frozen: true, status: 'frozen', caseStatus: 'approved' };
    return Promise.resolve('frozen');
  }

  reject(_t: string, _r: string, planId: string): Promise<void> {
    const index = this.plans.findIndex((p) => p.planId === planId);
    const plan = this.plans[index];
    if (plan !== undefined) this.plans[index] = { ...plan, status: 'rejected' };
    return Promise.resolve();
  }
}

class MemoryDecisions implements GateDecisions {
  readonly rows: Gate1DecisionRecord[] = [];

  record(decision: Gate1DecisionRecord): Promise<boolean> {
    if (this.rows.some((r) => r.planId === decision.planId)) return Promise.resolve(false);
    this.rows.push(decision);
    return Promise.resolve(true);
  }
}

class MemoryEnvelopes implements RunEnvelopes {
  readonly frozen: RunEnvelopeRecord[] = [];

  freeze(envelope: RunEnvelopeRecord): Promise<void> {
    if (!this.frozen.some((e) => e.runId === envelope.runId)) this.frozen.push(envelope);
    return Promise.resolve();
  }
}

/** Answers with scripted outputs, one per call; the last one repeats. An `Error` rejects. */
export class FakePlanner implements PlannerSessions {
  readonly requests: PlannerRequest[] = [];
  readonly aborted: string[] = [];

  constructor(private readonly outputs: readonly unknown[] = [{ testCases: [testCase()] }]) {}

  propose(request: PlannerRequest): Promise<unknown> {
    this.requests.push(request);
    const output = this.outputs[Math.min(this.requests.length, this.outputs.length) - 1];
    return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
  }

  abort(_t: string, runId: string): Promise<void> {
    this.aborted.push(runId);
    return Promise.resolve();
  }
}

export class FakePermissions implements Gate1Permissions {
  constructor(private readonly allowed: readonly string[] = [APPROVER]) {}

  canApprove(_t: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.allowed.includes(userId));
  }
}

class FakePager implements Pager {
  readonly pages: string[] = [];

  page(request: { message: string }): Promise<void> {
    this.pages.push(request.message);
    return Promise.resolve();
  }
}

class MemoryAudit implements PlanningAuditSink {
  readonly records: PlanningAuditRecord[] = [];

  append(record: PlanningAuditRecord): Promise<void> {
    if (!this.records.some((r) => r.dedupeKey === record.dedupeKey)) this.records.push(record);
    return Promise.resolve();
  }

  actions(): string[] {
    return this.records.map((r) => r.action);
  }
}

class FakeMetrics implements PlanningMetrics {
  readonly cases: [string, number][] = [];
  readonly decisions: [string, boolean][] = [];
  readonly waits: number[] = [];

  testCases(testClass: string, count: number): void {
    this.cases.push([testClass, count]);
  }

  gate1Decision(decision: string, auto: boolean): void {
    this.decisions.push([decision, auto]);
  }

  gate1Wait(seconds: number): void {
    this.waits.push(seconds);
  }
}

export interface Harness {
  readonly deps: PlanningActivityDeps;
  readonly runs: MemoryRunState;
  readonly sas: MemorySas;
  readonly plans: MemoryPlans;
  readonly decisions: MemoryDecisions;
  readonly envelopes: MemoryEnvelopes;
  readonly planner: FakePlanner;
  readonly pager: FakePager;
  readonly audit: MemoryAudit;
  readonly metrics: FakeMetrics;
}

export function makeHarness(over: Partial<PlanningActivityDeps> = {}): Harness {
  const runs = (over.runs as MemoryRunState | undefined) ?? new MemoryRunState();
  const sas = (over.sas as MemorySas | undefined) ?? new MemorySas();
  const plans = (over.plans as MemoryPlans | undefined) ?? new MemoryPlans();
  const decisions = (over.decisions as MemoryDecisions | undefined) ?? new MemoryDecisions();
  const envelopes = (over.envelopes as MemoryEnvelopes | undefined) ?? new MemoryEnvelopes();
  const planner = (over.planner as FakePlanner | undefined) ?? new FakePlanner();
  const pager = (over.pager as FakePager | undefined) ?? new FakePager();
  const audit = (over.audit as MemoryAudit | undefined) ?? new MemoryAudit();
  const metrics = (over.metrics as FakeMetrics | undefined) ?? new FakeMetrics();
  const deps: PlanningActivityDeps = {
    runs,
    sas,
    plans,
    decisions,
    envelopes,
    planner,
    permissions: over.permissions ?? new FakePermissions(),
    pager,
    audit,
    metrics,
    log: createLogger('planning-test'),
    now: () => NOW,
  };
  return { deps, runs, sas, plans, decisions, envelopes, planner, pager, audit, metrics };
}

export function makeActivities(h: Harness): ReturnType<typeof createPlanningActivities> {
  return createPlanningActivities(h.deps);
}
