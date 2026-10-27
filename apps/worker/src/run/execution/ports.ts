import type {
  FrontierCounts,
  Gate2Decision,
  Gate2Request,
  MentorReason,
  OrchestratorStopReason,
} from './types.js';

/**
 * Ports the execution phase depends on. The agent runtime and session manager (the orchestrator
 * session, the specialist sessions, `sessionStore`), the engagement tools (MCP-012), the dispatch layer
 * (ORCH-007), the gates API and policy decision point own the real adapters; each is a seam here so the
 * orchestration is testable and fails closed. A port that throws means "could not answer": the activity
 * is retried. Run state, paging and the ledger reuse the post-execution ports.
 */
export type {
  Pager,
  PostExecutionRunState as ExecutionRunState,
  RunStateFacts,
} from '../postexec/ports.js';

/** Streams of the orchestrator session that the activity needs to see. */
export interface OrchestratorRunHooks {
  /** Called for every tool the orchestrator calls (for the dispatch counter). */
  onToolUse(toolName: string): void;
}

/**
 * The long-running orchestrator session (persona `orchestrator`: engagement MCP tools only, no Bash).
 * It runs with `includePartialMessages: true` and the `sessionStore`, so it can be resumed.
 */
export interface OrchestratorSessions {
  /** Starts the run's orchestrator session, or returns the stored one (idempotent per run). */
  start(tenantId: string, runId: string): Promise<{ readonly sessionId: string }>;
  /**
   * Runs (or resumes from `sessionStore`) until the session stops. Interrupts the session and rejects
   * when `signal` aborts. Rejects when the session crashes.
   */
  run(
    request: { readonly tenantId: string; readonly runId: string; readonly sessionId: string },
    hooks: OrchestratorRunHooks,
    signal: AbortSignal,
  ): Promise<OrchestratorStopReason>;
  /** Ends the run's orchestrator session. Idempotent. */
  stop(tenantId: string, runId: string): Promise<void>;
}

/** The blackboard's view of the subtask frontier (REFERENCES §2), from `test_cases` and `subtasks`. */
export interface SubtaskFrontier {
  snapshot(tenantId: string, runId: string): Promise<FrontierCounts>;
}

export type ResumeOutcome = 'resumed' | 'session_expired';

/** Control over specialist sessions and their subtasks (dispatch mechanics are ORCH-007's). */
export interface SpecialistBranches {
  /**
   * Resumes a session that stopped with `tool_deferred` so its PreToolUse hook returns allow or deny for
   * `toolUseId`. Idempotent per `toolUseId`. `session_expired` when the session can no longer resume.
   */
  resumeDeferred(request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly toolUseId: string;
    readonly decision: Gate2Decision;
    readonly reason: string;
  }): Promise<ResumeOutcome>;
  /** Denies a call with a reason (no `defer`) and pauses the branch's session. Idempotent. */
  denyAndPause(request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly toolUseId: string;
    readonly reason: string;
  }): Promise<void>;
  /** Sets the subtask `blocked` with a reason code (terminal; the orchestrator may re-plan). */
  markBlocked(tenantId: string, runId: string, subtaskId: string, reason: string): Promise<void>;
  /** Sets the subtask back to `open` so ORCH-007 dispatches it again. Idempotent. */
  requeue(tenantId: string, runId: string, subtaskId: string): Promise<void>;
  /** Cancels every specialist session of the run (kill or cancel). Idempotent. */
  cancelAll(tenantId: string, runId: string): Promise<void>;
}

export interface Gate2Row {
  readonly decisionId: string;
  readonly request: Gate2Request;
  readonly status: 'pending' | 'approved' | 'denied';
  readonly requestedAt: string;
  readonly timeoutAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
  /** True when the system decided (timeout or cancellation). */
  readonly auto: boolean;
}

/** `gate_decisions` rows with gate = 2, tenant-scoped (RLS). */
export interface Gate2Store {
  /** Creates the pending row, or returns the existing one for `request.dedupeKey`. */
  open(
    tenantId: string,
    runId: string,
    request: Gate2Request,
    timeoutAt: string,
    requestedAt: string,
  ): Promise<{ readonly row: Gate2Row; readonly created: boolean }>;
  get(tenantId: string, decisionId: string): Promise<Gate2Row | null>;
  /** Compare-and-set from `pending`; false when the row was already decided. */
  decide(
    tenantId: string,
    decisionId: string,
    outcome: {
      readonly decision: Gate2Decision;
      readonly decidedBy: string | null;
      readonly decidedAt: string;
      readonly reason: string;
      readonly auto: boolean;
    },
  ): Promise<boolean>;
  listPending(tenantId: string, runId: string): Promise<readonly Gate2Row[]>;
}

/** RBAC check for deciding Gate 2 (an Asset Owner of the run's assets) in the tenant. */
export interface Gate2Permissions {
  canDecide(tenantId: string, userId: string): Promise<boolean>;
}

/** The policy decision point's time-bound scope exceptions (POLICY). */
export interface ScopeExceptions {
  /** Grants (approved) or records the refusal of (denied) the exception the orchestrator asked for. */
  resolve(request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly decisionId: string;
    readonly target: string;
    readonly decision: Gate2Decision;
    readonly decidedBy: string | null;
  }): Promise<void>;
}

/** Mentor and reflector sessions: read-only advice written to the blackboard, never a safety control. */
export interface AdvisorySessions {
  run(request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly role: 'mentor' | 'reflector';
    readonly reason: MentorReason;
  }): Promise<void>;
}

export interface ExecutionAuditRecord {
  readonly action:
    | 'orchestrator.started'
    | 'gate2.opened'
    | 'gate2.decided'
    | 'scope_exception.requested'
    | 'mentor.requested'
    | 'branch.paused'
    | 'execution.completed'
    | 'run.state_changed';
  readonly outcome: 'success' | 'failure';
  readonly tenantId: string;
  readonly runId: string;
  readonly actorId: string | null;
  readonly occurredAt: string;
  /** Stable per run and event, so a retried activity cannot append a duplicate. */
  readonly dedupeKey: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** Append-only audit writer (§8.8). A failure must surface so Temporal retries the activity. */
export interface ExecutionAuditSink {
  append(record: ExecutionAuditRecord): Promise<void>;
}

export interface ExecutionMetrics {
  /** `blackwing_gate2_total{decision}`; `timeout` is a deny by the clock. */
  gate2(decision: Gate2Decision | 'timeout'): void;
  /** `blackwing_gate2_wait_seconds`. */
  gate2Wait(seconds: number): void;
  /** `blackwing_orchestrator_dispatches_total`. */
  dispatch(): void;
  /** `blackwing_mentor_interventions_total{role}`. */
  mentorIntervention(role: 'mentor' | 'reflector'): void;
}

/** Heartbeat and cancellation of the running Temporal activity (injected so units need no worker). */
export interface ActivityRuntime {
  heartbeat(): void;
  readonly cancellationSignal: AbortSignal;
}
