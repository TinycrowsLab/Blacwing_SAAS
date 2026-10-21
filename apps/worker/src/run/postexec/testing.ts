import { createLogger } from '@blackwing/logger';

import { createPostExecutionActivities, type PostExecutionActivityDeps } from './activities.js';

import type {
  CoverageManifest,
  DecisionRecord,
  FindingFact,
  FindingFactStatus,
  Gate3Permissions,
  Pager,
  OutcomeRecord,
  PostExecutionAuditRecord,
  PostExecutionAuditSink,
  PostExecutionFindingRepo,
  PostExecutionMetrics,
  PostExecutionRunState,
  RunStateFacts,
  Validator,
  WriteUpSessions,
} from './ports.js';
import type { PostExecutionRef, ReporterRole, ValidatorVerdict } from './types.js';
import type { RunStatus } from '@blackwing/domain';

// Test doubles for the post-execution activities (shared by the unit and integration tests). Not
// exported from the package.

const TENANT = '0190a000-0000-7000-8000-000000000001';
const RUN_ID = '0190a000-0000-7000-8000-0000000000b1';
export const REF: PostExecutionRef = { tenantId: TENANT, runId: RUN_ID };
export const REQUESTER = 'user-requester';
export const ANALYST = 'user-analyst';
const NOW = new Date('2026-01-01T12:00:00.000Z');

export class MemoryFindings implements PostExecutionFindingRepo {
  readonly status = new Map<string, FindingFactStatus>();
  readonly outcomes: OutcomeRecord[] = [];
  readonly decisions: DecisionRecord[] = [];

  constructor(initial: Record<string, FindingFactStatus> = {}) {
    for (const [id, s] of Object.entries(initial)) this.status.set(id, s);
  }

  listUnresolved(): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.status].filter(([, s]) => s === 'candidate' || s === 'validating').map(([id]) => id),
    );
  }

  list(): Promise<readonly FindingFact[]> {
    return Promise.resolve([...this.status].map(([findingId, status]) => ({ findingId, status })));
  }

  recordOutcome(_t: string, _r: string, outcome: OutcomeRecord): Promise<boolean> {
    const current = this.status.get(outcome.findingId);
    if (current === outcome.status) return Promise.resolve(false);
    if (current !== 'candidate' && current !== 'validating' && current !== 'suspected') {
      return Promise.resolve(false);
    }
    this.status.set(outcome.findingId, outcome.status);
    this.outcomes.push(outcome);
    return Promise.resolve(true);
  }

  applyDecision(_t: string, _r: string, decision: DecisionRecord): Promise<boolean> {
    if (this.status.get(decision.findingId) !== 'confirmed') return Promise.resolve(false);
    this.status.set(decision.findingId, decision.decision);
    this.decisions.push(decision);
    return Promise.resolve(true);
  }
}

export class MemoryRunState implements PostExecutionRunState {
  facts: RunStateFacts;
  failNextSave = false;

  constructor(state: RunStatus['state'] = 'executing', requestedBy: string | null = REQUESTER) {
    this.facts = {
      status: { state, version: 7 } as RunStatus,
      requestedBy,
      envelopeValid: true,
    };
  }

  get state(): RunStatus['state'] {
    return this.facts.status.state;
  }

  load(): Promise<RunStateFacts | null> {
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

export const CONFIRMED_VERDICT: ValidatorVerdict = {
  oraclePassed: true,
  negativeControlFired: false,
  evidenceBundleId: 'evb-1',
  reproArtifactId: 'repro-1',
};

export class FakeValidator implements Validator {
  readonly aborted: string[] = [];
  readonly calls: string[] = [];

  constructor(
    private readonly verdicts: Record<string, ValidatorVerdict | Error> = {},
    private readonly fallback: ValidatorVerdict = CONFIRMED_VERDICT,
  ) {}

  validate(request: { findingId: string }): Promise<ValidatorVerdict> {
    this.calls.push(request.findingId);
    const v = this.verdicts[request.findingId] ?? this.fallback;
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  }

  abortRun(_t: string, runId: string): Promise<void> {
    this.aborted.push(runId);
    return Promise.resolve();
  }
}

export class FakeSessions implements WriteUpSessions {
  readonly started: { role: ReporterRole; findingIds: readonly string[] }[] = [];
  constructor(private readonly failRole?: ReporterRole) {}

  run(request: { role: ReporterRole; findingIds: readonly string[] }): Promise<void> {
    if (request.role === this.failRole) return Promise.reject(new Error('session crashed'));
    this.started.push({ role: request.role, findingIds: request.findingIds });
    return Promise.resolve();
  }
}

export class FakeCoverage implements CoverageManifest {
  finalised = false;
  /** When true, `finalise` records nothing, to prove completion re-checks the manifest. */
  broken = false;

  finalise(): Promise<void> {
    if (!this.broken) this.finalised = true;
    return Promise.resolve();
  }

  isFinalised(): Promise<boolean> {
    return Promise.resolve(this.finalised);
  }
}

export class FakePermissions implements Gate3Permissions {
  constructor(private readonly allowed: readonly string[] = [ANALYST]) {}

  canRelease(_t: string, userId: string): Promise<boolean> {
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

class MemoryAudit implements PostExecutionAuditSink {
  readonly records: PostExecutionAuditRecord[] = [];

  append(record: PostExecutionAuditRecord): Promise<void> {
    if (!this.records.some((r) => r.dedupeKey === record.dedupeKey)) this.records.push(record);
    return Promise.resolve();
  }

  actions(): string[] {
    return this.records.map((r) => r.action);
  }
}

class FakeMetrics implements PostExecutionMetrics {
  readonly candidates: string[] = [];
  readonly decisions: string[] = [];
  releasedCount = 0;

  candidate(result: 'confirmed' | 'suspected'): void {
    this.candidates.push(result);
  }

  gate3Decision(decision: string): void {
    this.decisions.push(decision);
  }

  released(): void {
    this.releasedCount++;
  }
}

export interface Harness {
  readonly deps: PostExecutionActivityDeps;
  readonly findings: MemoryFindings;
  readonly runs: MemoryRunState;
  readonly validator: FakeValidator;
  readonly sessions: FakeSessions;
  readonly coverage: FakeCoverage;
  readonly pager: FakePager;
  readonly audit: MemoryAudit;
  readonly metrics: FakeMetrics;
}

export function makeHarness(over: Partial<PostExecutionActivityDeps> = {}): Harness {
  const findings = (over.findings as MemoryFindings | undefined) ?? new MemoryFindings();
  const runs = (over.runs as MemoryRunState | undefined) ?? new MemoryRunState();
  const validator = (over.validator as FakeValidator | undefined) ?? new FakeValidator();
  const sessions = (over.sessions as FakeSessions | undefined) ?? new FakeSessions();
  const coverage = (over.coverage as FakeCoverage | undefined) ?? new FakeCoverage();
  const pager = (over.pager as FakePager | undefined) ?? new FakePager();
  const audit = (over.audit as MemoryAudit | undefined) ?? new MemoryAudit();
  const metrics = (over.metrics as FakeMetrics | undefined) ?? new FakeMetrics();
  const deps: PostExecutionActivityDeps = {
    findings,
    runs,
    validator,
    sessions,
    coverage,
    permissions: over.permissions ?? new FakePermissions(),
    pager,
    audit,
    metrics,
    log: createLogger('postexec-test'),
    now: () => NOW,
  };
  return { deps, findings, runs, validator, sessions, coverage, pager, audit, metrics };
}

export function makeActivities(h: Harness): ReturnType<typeof createPostExecutionActivities> {
  return createPostExecutionActivities(h.deps);
}
