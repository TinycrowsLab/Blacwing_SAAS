import { applyGate2Event, type Gate2State, type RunStatus } from '@blackwing/domain';
import { createLogger } from '@blackwing/logger';

import { createExecutionActivities, type ExecutionActivityDeps } from './activities.js';
import { refusalOf } from './gate2-exception.js';

import type {
  ActivityRuntime,
  AdvisorySessions,
  ExecutionAuditRecord,
  ExecutionAuditSink,
  ExecutionMetrics,
  ExecutionRunState,
  Gate2ExceptionRead,
  Gate2ExceptionStore,
  Gate2Permissions,
  Gate2Row,
  Gate2Store,
  OrchestratorRunHooks,
  OrchestratorSessions,
  Pager,
  ResumeOutcome,
  RunStateFacts,
  ScopeExceptions,
  SpecialistBranches,
  SubtaskFrontier,
} from './ports.js';
import type {
  ExecutionEvent,
  ExecutionRef,
  FrontierCounts,
  Gate2Decision,
  Gate2ExceptionEvent,
  Gate2ExceptionVerdict,
  Gate2Request,
  OrchestratorStopReason,
} from './types.js';
import type { IntrusivenessClass } from '@blackwing/contracts';

// Test doubles for the execution-phase activities (shared by the unit and integration tests). Not
// exported from the package.

export const REF: ExecutionRef = {
  tenantId: '0190a000-0000-7000-8000-000000000001',
  runId: '0190a000-0000-7000-8000-0000000000b1',
};
export const REQUESTER = 'user-requester';
export const APPROVER = 'user-approver';
const NOW = new Date('2026-01-01T12:00:00.000Z');

export class MemoryRunState implements ExecutionRunState {
  facts: RunStateFacts;

  constructor(state: RunStatus['state'] = 'approved', requestedBy: string | null = REQUESTER) {
    this.facts = { status: { state, version: 3 } as RunStatus, requestedBy, envelopeValid: true };
  }

  get state(): RunStatus['state'] {
    return this.facts.status.state;
  }

  load(): Promise<RunStateFacts | null> {
    return Promise.resolve(this.facts);
  }

  save(_t: string, _r: string, expectedVersion: number, next: RunStatus): Promise<boolean> {
    if (expectedVersion !== this.facts.status.version) return Promise.resolve(false);
    this.facts = { ...this.facts, status: next };
    return Promise.resolve(true);
  }
}

/** Scriptable frontier: tests set `counts` directly or let `onSnapshot` evolve it. */
export class FakeFrontier implements SubtaskFrontier {
  counts: FrontierCounts = {
    eligible: 2,
    open: 0,
    inFlight: 0,
    awaitingGate2: 0,
    terminal: 0,
    activitySeq: 0,
  };
  reads = 0;

  constructor(private readonly onSnapshot?: (f: FakeFrontier) => void) {}

  snapshot(): Promise<FrontierCounts> {
    this.reads++;
    this.onSnapshot?.(this);
    return Promise.resolve(this.counts);
  }

  /** Marks every subtask dispatched and finished. */
  drain(): void {
    this.counts = {
      eligible: 0,
      open: 0,
      inFlight: 0,
      awaitingGate2: 0,
      terminal:
        this.counts.terminal + this.counts.eligible + this.counts.open + this.counts.inFlight,
      activitySeq: this.counts.activitySeq + 1,
    };
  }
}

export class FakeOrchestrator implements OrchestratorSessions {
  readonly started: string[] = [];
  readonly runs: string[] = [];
  readonly stops: string[] = [];
  readonly tools: string[] = [];
  /** One entry per call of `run`: a stop reason, an Error to reject with, or a function to act. */
  script: (
    | OrchestratorStopReason
    | Error
    | ((hooks: OrchestratorRunHooks, signal: AbortSignal) => Promise<OrchestratorStopReason>)
  )[] = [];

  start(_t: string, runId: string): Promise<{ sessionId: string }> {
    this.started.push(runId);
    return Promise.resolve({ sessionId: 'sess-orch-1' });
  }

  async run(
    request: { sessionId: string },
    hooks: OrchestratorRunHooks,
    signal: AbortSignal,
  ): Promise<OrchestratorStopReason> {
    this.runs.push(request.sessionId);
    const step = this.script.shift() ?? 'end_turn';
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(hooks, signal);
    return step;
  }

  stop(_t: string, runId: string): Promise<void> {
    this.stops.push(runId);
    return Promise.resolve();
  }
}

class FakeBranches implements SpecialistBranches {
  readonly resumed: {
    sessionId: string;
    toolUseId: string;
    decision: Gate2Decision;
    reason: string;
  }[] = [];
  readonly denied: { sessionId: string; toolUseId: string; reason: string }[] = [];
  readonly blocked: { subtaskId: string; reason: string }[] = [];
  readonly requeued: string[] = [];
  cancelled = 0;
  resumeOutcome: ResumeOutcome = 'resumed';

  resumeDeferred(request: {
    sessionId: string;
    toolUseId: string;
    decision: Gate2Decision;
    reason: string;
  }): Promise<ResumeOutcome> {
    this.resumed.push(request);
    return Promise.resolve(this.resumeOutcome);
  }

  denyAndPause(request: { sessionId: string; toolUseId: string; reason: string }): Promise<void> {
    this.denied.push(request);
    return Promise.resolve();
  }

  markBlocked(_t: string, _r: string, subtaskId: string, reason: string): Promise<void> {
    this.blocked.push({ subtaskId, reason });
    return Promise.resolve();
  }

  requeue(_t: string, _r: string, subtaskId: string): Promise<void> {
    this.requeued.push(subtaskId);
    return Promise.resolve();
  }

  cancelAll(): Promise<void> {
    this.cancelled++;
    return Promise.resolve();
  }
}

class MemoryGates implements Gate2Store {
  readonly rows = new Map<string, Gate2Row>();
  private seq = 0;

  open(
    _t: string,
    _r: string,
    request: Gate2Request,
    timeoutAt: string,
    requestedAt: string,
  ): Promise<{ row: Gate2Row; created: boolean }> {
    const existing = [...this.rows.values()].find((r) => r.request.dedupeKey === request.dedupeKey);
    if (existing !== undefined) return Promise.resolve({ row: existing, created: false });
    const row: Gate2Row = {
      decisionId: `gate2-${++this.seq}`,
      request,
      status: 'pending',
      requestedAt,
      timeoutAt,
      decidedBy: null,
      decidedAt: null,
      reason: null,
      auto: false,
    };
    this.rows.set(row.decisionId, row);
    return Promise.resolve({ row, created: true });
  }

  get(_t: string, decisionId: string): Promise<Gate2Row | null> {
    return Promise.resolve(this.rows.get(decisionId) ?? null);
  }

  decide(
    _t: string,
    decisionId: string,
    outcome: {
      decision: Gate2Decision;
      decidedBy: string | null;
      decidedAt: string;
      reason: string;
      auto: boolean;
    },
  ): Promise<boolean> {
    const row = this.rows.get(decisionId);
    if (row?.status !== 'pending') return Promise.resolve(false);
    this.rows.set(decisionId, {
      ...row,
      status: outcome.decision,
      decidedBy: outcome.decidedBy,
      decidedAt: outcome.decidedAt,
      reason: outcome.reason,
      auto: outcome.auto,
    });
    return Promise.resolve(true);
  }

  listPending(): Promise<readonly Gate2Row[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.status === 'pending'));
  }

  only(): Gate2Row {
    const [row] = [...this.rows.values()];
    if (row === undefined) throw new Error('no gate2 row');
    return row;
  }
}

class FakePermissions implements Gate2Permissions {
  constructor(private readonly allowed: readonly string[] = [APPROVER]) {}

  canDecide(_t: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.allowed.includes(userId));
  }
}

class FakeScopeExceptions implements ScopeExceptions {
  readonly resolved: { decisionId: string; target: string; decision: Gate2Decision }[] = [];

  resolve(request: { decisionId: string; target: string; decision: Gate2Decision }): Promise<void> {
    this.resolved.push(request);
    return Promise.resolve();
  }
}

class FakeAdvisors implements AdvisorySessions {
  readonly runs: { role: 'mentor' | 'reflector'; reason: string }[] = [];
  fail = false;

  run(request: { role: 'mentor' | 'reflector'; reason: string }): Promise<void> {
    if (this.fail) return Promise.reject(new Error('advisory session crashed'));
    this.runs.push({ role: request.role, reason: request.reason });
    return Promise.resolve();
  }
}

interface MemoryException {
  readonly id: string;
  readonly runId: string;
  readonly intrusiveness: IntrusivenessClass;
  state: Gate2State;
  version: number;
  readonly requesterId: string | null;
  readonly planApproverId: string | null;
  readonly timeoutAt: Date;
  decidedBy: string | null;
}

/**
 * `gate2_exceptions` double (GATE2-004). Runs the real Gate 2 state machine (`applyGate2Event`), so separation of
 * duties, default deny and the timeout guard behave as they do in production.
 */
export class MemoryGate2Exceptions implements Gate2ExceptionStore {
  readonly rows = new Map<string, MemoryException>();
  /** Every applied event, in order. */
  readonly applied: { exceptionId: string; event: Gate2ExceptionEvent; actorId: string }[] = [];
  clock: () => Date = () => new Date();

  /** Opens a pending exception due `dueInMs` from now, requested by `requesterId`. */
  raise(
    exceptionId: string,
    dueInMs: number,
    options: {
      runId?: string;
      requesterId?: string | null;
      planApproverId?: string | null;
      intrusiveness?: IntrusivenessClass;
    } = {},
  ): void {
    this.rows.set(exceptionId, {
      id: exceptionId,
      runId: options.runId ?? REF.runId,
      intrusiveness: options.intrusiveness ?? 'state_changing',
      state: 'pending',
      version: 0,
      requesterId: options.requesterId === undefined ? REQUESTER : options.requesterId,
      planApproverId: options.planApproverId ?? null,
      timeoutAt: new Date(this.clock().getTime() + dueInMs),
      decidedBy: null,
    });
  }

  state(exceptionId: string): Gate2State | undefined {
    return this.rows.get(exceptionId)?.state;
  }

  read(_t: string, runId: string, exceptionId: string): Promise<Gate2ExceptionRead | null> {
    const row = this.rows.get(exceptionId);
    if (row?.runId !== runId) return Promise.resolve(null);
    return Promise.resolve({
      state: row.state,
      timeoutAt: row.timeoutAt.toISOString(),
      now: this.clock().toISOString(),
    });
  }

  apply(
    _t: string,
    runId: string,
    exceptionId: string,
    change: {
      readonly event: Gate2ExceptionEvent;
      readonly actor: { readonly kind: 'user' | 'system'; readonly id: string };
      readonly reason?: string;
    },
  ): Promise<Gate2ExceptionVerdict> {
    const row = this.rows.get(exceptionId);
    if (row?.runId !== runId) {
      return Promise.resolve({ kind: 'refused', code: 'GATE2_NOT_FOUND' });
    }
    if (row.state !== 'pending') {
      const person = change.event === 'approve' || change.event === 'deny';
      return Promise.resolve(
        person
          ? { kind: 'refused', code: 'GATE2_ALREADY_DECIDED' }
          : { kind: 'lost', state: row.state },
      );
    }
    try {
      const result = applyGate2Event(
        {
          state: row.state,
          version: row.version,
          intrusiveness: row.intrusiveness,
          requesterId: row.requesterId,
          planApproverId: row.planApproverId,
          timeoutAt: row.timeoutAt,
        },
        { type: change.event },
        {
          actor: change.actor,
          now: this.clock(),
          ...(change.reason === undefined ? {} : { reason: change.reason }),
        },
      );
      row.state = result.next.state;
      row.version = result.next.version;
      row.decidedBy = result.next.decidedBy;
      this.applied.push({ exceptionId, event: change.event, actorId: change.actor.id });
      return Promise.resolve({ kind: 'applied', state: row.state });
    } catch (error) {
      const code = refusalOf(error);
      if (code === undefined) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return Promise.resolve({ kind: 'refused', code });
    }
  }

  pendingIds(_t: string, runId: string): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.runId === runId && row.state === 'pending')
        .map((row) => row.id),
    );
  }
}

class FakePager implements Pager {
  readonly pages: string[] = [];

  page(request: { message: string }): Promise<void> {
    this.pages.push(request.message);
    return Promise.resolve();
  }
}

class MemoryAudit implements ExecutionAuditSink {
  readonly records: ExecutionAuditRecord[] = [];

  append(record: ExecutionAuditRecord): Promise<void> {
    if (!this.records.some((r) => r.dedupeKey === record.dedupeKey)) this.records.push(record);
    return Promise.resolve();
  }

  actions(): string[] {
    return this.records.map((r) => r.action);
  }
}

class FakeMetrics implements ExecutionMetrics {
  readonly gate2Decisions: string[] = [];
  readonly waits: number[] = [];
  dispatches = 0;
  readonly mentors: string[] = [];
  readonly escalations: number[] = [];

  gate2(decision: string): void {
    this.gate2Decisions.push(decision);
  }

  gate2Wait(seconds: number): void {
    this.waits.push(seconds);
  }

  dispatch(): void {
    this.dispatches++;
  }

  mentorIntervention(role: string): void {
    this.mentors.push(role);
  }

  gate2Escalation(level: number): void {
    this.escalations.push(level);
  }
}

export interface Harness {
  readonly deps: ExecutionActivityDeps;
  readonly runs: MemoryRunState;
  readonly orchestrator: FakeOrchestrator;
  readonly frontier: FakeFrontier;
  readonly branches: FakeBranches;
  readonly gates: MemoryGates;
  readonly scopeExceptions: FakeScopeExceptions;
  readonly advisors: FakeAdvisors;
  readonly pager: FakePager;
  readonly gate2Exceptions: MemoryGate2Exceptions;
  readonly audit: MemoryAudit;
  readonly metrics: FakeMetrics;
  readonly activity: ActivityRuntime & { readonly beats: number; abort(): void };
}

export function makeHarness(over: Partial<ExecutionActivityDeps> = {}): Harness {
  const runs = (over.runs as MemoryRunState | undefined) ?? new MemoryRunState();
  const orchestrator =
    (over.orchestrator as FakeOrchestrator | undefined) ?? new FakeOrchestrator();
  const frontier = (over.frontier as FakeFrontier | undefined) ?? new FakeFrontier();
  const branches = (over.branches as FakeBranches | undefined) ?? new FakeBranches();
  const gates = (over.gates as MemoryGates | undefined) ?? new MemoryGates();
  const scopeExceptions =
    (over.scopeExceptions as FakeScopeExceptions | undefined) ?? new FakeScopeExceptions();
  const advisors = (over.advisors as FakeAdvisors | undefined) ?? new FakeAdvisors();
  const pager = (over.pager as FakePager | undefined) ?? new FakePager();
  const gate2Exceptions =
    (over.gate2Exceptions as MemoryGate2Exceptions | undefined) ?? new MemoryGate2Exceptions();
  const audit = (over.audit as MemoryAudit | undefined) ?? new MemoryAudit();
  const metrics = (over.metrics as FakeMetrics | undefined) ?? new FakeMetrics();
  const controller = new AbortController();
  const activity = {
    beats: 0,
    heartbeat(): void {
      this.beats++;
    },
    cancellationSignal: controller.signal,
    abort(): void {
      controller.abort();
    },
  };
  const deps: ExecutionActivityDeps = {
    runs,
    orchestrator,
    frontier,
    branches,
    gates,
    gate2Exceptions,
    permissions: over.permissions ?? new FakePermissions(),
    scopeExceptions,
    advisors,
    pager,
    audit,
    metrics,
    log: createLogger('execution-test'),
    activity: () => activity,
    heartbeatMs: 5,
    now: () => NOW,
  };
  return {
    deps,
    runs,
    orchestrator,
    frontier,
    branches,
    gates,
    scopeExceptions,
    advisors,
    pager,
    gate2Exceptions,
    audit,
    metrics,
    activity,
  };
}

export function makeActivities(h: Harness): ReturnType<typeof createExecutionActivities> {
  return createExecutionActivities(h.deps);
}

export const SINGLE_CALL: Extract<ExecutionEvent, { type: 'out_of_envelope_call' }> = {
  type: 'out_of_envelope_call',
  subtaskId: 'st-1',
  sessionId: 'sess-spec-1',
  toolUseId: 'tu-1',
  toolName: 'mcp__blackwing_http__request',
  summary: 'GET https://api.example.test/admin',
  toolCallsInTurn: 1,
};

export const SCOPE_EXCEPTION: Extract<ExecutionEvent, { type: 'scope_exception_requested' }> = {
  type: 'scope_exception_requested',
  requestId: 'req-1',
  subtaskId: 'st-2',
  target: 'https://cdn.example.test',
  reason: 'the login flow loads its script from the CDN',
};

export const GATE2_REQUEST: Gate2Request = {
  kind: 'tool_deferred',
  dedupeKey: 'sess-spec-1:tu-1',
  subtaskId: 'st-1',
  sessionId: 'sess-spec-1',
  toolUseId: 'tu-1',
  summary: 'mcp__blackwing_http__request: GET https://api.example.test/admin',
  target: null,
};
