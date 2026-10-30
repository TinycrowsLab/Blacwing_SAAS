// Types and constants shared by the workflow bundle and the activities (ORCH-008). Type-only imports
// and plain values: this file is bundled for the deterministic workflow sandbox (no Node built-ins).

/** Workflow type name of the execution phase; the run workflow starts it as a child by this name. */
export const EXECUTION_WORKFLOW = 'ExecutionWorkflow';
/**
 * Signal carrying an {@link ExecutionEvent}. Sent by the dispatch layer (ORCH-007) when a specialist
 * session stops with `tool_deferred`, and by the engagement tools (MCP-012) when the orchestrator calls
 * `request_mentor_review` or `request_scope_exception`.
 */
export const EXECUTION_EVENT_SIGNAL = 'executionEvent';
/** Signal an approver sends (through the gates API) to decide one Gate 2 request. */
export const GATE2_DECIDED_SIGNAL = 'gate2Decided';
/**
 * Signal the Gate 2 broker (GATE2-002) sends after it persists a `gate2_exceptions` row. It names the
 * exception only; the workflow reads the state and `timeout_at` back, never trusts the signal for a decision.
 * Must equal `GATE2_EXCEPTION_RAISED_SIGNAL` in `@blackwing/contracts` (pinned by a test).
 */
export const GATE2_EXCEPTION_RAISED_SIGNAL = 'gate2ExceptionRaised';
/** Signal the gates API sends to decide one Gate 2 exception (GATE2-004). */
export const GATE2_EXCEPTION_DECISION_SIGNAL = 'gate2Decision';
/** Signal sent after an operator resumed a paused execution (the API applies the `resume` event). */
export const EXECUTION_RESUMED_SIGNAL = 'executionResumed';
/** Query returning {@link ExecutionProgress}. */
export const EXECUTION_PROGRESS_QUERY = 'executionProgress';

/** Default Gate 2 timeout, `gate2_timeout_minutes` (§4.2, F13). No reply by then means denied. */
export const DEFAULT_GATE2_TIMEOUT_MINUTES = 30;
/**
 * Escalation ladder of a Gate 2 exception, in seconds after the wait starts: page level 0 at once, level 1 at
 * `GATE2_ESCALATE_1` (120s) and level 2 at `GATE2_ESCALATE_2` (300s). Steps past the decision deadline never fire.
 */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- escalation offsets in seconds (GATE2_ESCALATE_1, GATE2_ESCALATE_2)
export const DEFAULT_GATE2_ESCALATION_SECONDS = [0, 120, 300] as const;
/** Default supervision poll interval, in milliseconds. */
export const DEFAULT_POLL_MS = 60_000;
/** Consecutive polls with no progress before the loop counts as stalled (default 10 minutes). */
export const DEFAULT_STALL_POLLS = 10;
/** Mentor interventions before the run pauses as `operator_pause`. */
export const DEFAULT_MAX_MENTOR_INTERVENTIONS = 3;
/** Orchestrator crashes the workflow resumes from `sessionStore` before it gives up. */
export const DEFAULT_MAX_ORCHESTRATOR_RECOVERIES = 5;

export interface ExecutionRef {
  readonly tenantId: string;
  readonly runId: string;
}

export interface ExecutionInput extends ExecutionRef {
  /** `gate2_timeout_minutes` (default {@link DEFAULT_GATE2_TIMEOUT_MINUTES}). */
  readonly gate2TimeoutMinutes?: number;
  /** Supervision poll interval in milliseconds (default {@link DEFAULT_POLL_MS}). */
  readonly pollMs?: number;
  /** Polls without progress before a stall (default {@link DEFAULT_STALL_POLLS}). */
  readonly stallPolls?: number;
  /** Mentor interventions before `operator_pause` (default {@link DEFAULT_MAX_MENTOR_INTERVENTIONS}). */
  readonly maxMentorInterventions?: number;
  /** Orchestrator crash recoveries (default {@link DEFAULT_MAX_ORCHESTRATOR_RECOVERIES}). */
  readonly maxOrchestratorRecoveries?: number;
  /** Escalation ladder offsets for broker-raised Gate 2 exceptions (default {@link DEFAULT_GATE2_ESCALATION_SECONDS}). */
  readonly gate2EscalationSeconds?: readonly number[];
}

/** Payload of the `gate2Decision` signal. `actorId` is the authenticated approver the gates API resolved. */
export interface Gate2ExceptionDecisionSignal {
  readonly exceptionId: string;
  readonly decision: 'approve_once' | 'deny';
  readonly actorId: string;
  readonly reason: string;
}

/** Payload of the `gate2ExceptionRaised` signal. */
export interface Gate2ExceptionRaisedSignal {
  readonly exceptionId: string;
}

/** Events the workflow applies to a `gate2_exceptions` row (the state machine's `GATE2_EVENT_TYPES`). */
export type Gate2ExceptionEvent = 'approve' | 'deny' | 'time_out' | 'supersede';

export type Gate2ExceptionState =
  'pending' | 'approved_once' | 'denied' | 'timed_out' | 'superseded';

/** A refused Gate 2 exception event. A refusal is a value: the exception stays pending (a person may retry). */
export type Gate2ExceptionRefusal =
  | 'GATE2_SOD_VIOLATION'
  | 'GATE2_ALREADY_DECIDED'
  | 'GATE2_ILLEGAL_TRANSITION'
  | 'GATE2_DESTRUCTIVE_FORBIDDEN'
  | 'GATE2_NOT_FOUND';

/** What the workflow reads for one exception: its state, the deadline (`timeout_at`) and the database clock. */
export interface Gate2ExceptionSnapshot {
  readonly exceptionId: string;
  readonly state: Gate2ExceptionState;
  readonly timeoutAt: string;
  readonly now: string;
}

/**
 * Result of one exception event. `applied`: the event won and is recorded. `lost`: a system event found the
 * exception already decided (the first committed decision wins). `refused`: the event was not allowed.
 */
export type Gate2ExceptionVerdict =
  | { readonly kind: 'applied'; readonly state: Gate2ExceptionState }
  | { readonly kind: 'lost'; readonly state: Gate2ExceptionState }
  | { readonly kind: 'refused'; readonly code: Gate2ExceptionRefusal };

/**
 * Something outside the workflow needs a decision or a reaction. Every free-text field is untrusted
 * (agent or target derived): it is stored and shown as data, never interpreted.
 */
export type ExecutionEvent =
  | {
      /** A specialist session stopped with `stop_reason:'tool_deferred'` on an out-of-envelope call. */
      readonly type: 'out_of_envelope_call';
      readonly subtaskId: string;
      readonly sessionId: string;
      readonly toolUseId: string;
      readonly toolName: string;
      /** Short, human-readable description of the call. Untrusted. */
      readonly summary: string;
      /** Tool calls in the turn that made the call. `defer` only works for exactly one (§4.2). */
      readonly toolCallsInTurn: number;
    }
  | {
      /** The orchestrator called `request_scope_exception`. */
      readonly type: 'scope_exception_requested';
      readonly requestId: string;
      readonly subtaskId: string | null;
      readonly target: string;
      readonly reason: string;
    }
  | {
      /** The orchestrator called `request_mentor_review`. */
      readonly type: 'mentor_review_requested';
      readonly requestId: string;
      readonly reason: string;
    };

/** What a Gate 2 decision is about. */
export type Gate2Kind = 'tool_deferred' | 'scope_exception';

/** Opens one Gate 2 decision (`gate_decisions`, gate = 2). `dedupeKey` makes opening idempotent. */
export interface Gate2Request {
  readonly kind: Gate2Kind;
  readonly dedupeKey: string;
  readonly subtaskId: string | null;
  /** Deferred specialist session and tool call; `null` for a scope exception. */
  readonly sessionId: string | null;
  readonly toolUseId: string | null;
  /** Sanitised, truncated description (see `sanitiseSummary`). */
  readonly summary: string;
  /** Scope exceptions only: the requested target. */
  readonly target: string | null;
}

export type Gate2Decision = 'approved' | 'denied';

/** Payload of the `gate2Decided` signal. The actor is the authenticated approver the API resolved. */
export interface Gate2DecidedSignal {
  readonly decisionId: string;
  readonly actorId: string;
  readonly decision: Gate2Decision;
  readonly reason?: string;
}

/** How a Gate 2 decision is made: by a human, or automatically (timeout and cancellation deny). */
export type Gate2Resolution =
  | {
      readonly kind: 'human';
      readonly actorId: string;
      readonly decision: Gate2Decision;
      readonly reason?: string;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' };

export type Gate2RefusalCode =
  'GATE2_NOT_FOUND' | 'GATE2_ALREADY_DECIDED' | 'GATE2_SOD_VIOLATION' | 'GATE2_NOT_PERMITTED';

/** Result of deciding. A refusal is a value (never retried); the workflow keeps waiting. */
export type Gate2Verdict =
  | { readonly accepted: true; readonly decision: Gate2Decision; readonly auto: boolean }
  | { readonly accepted: false; readonly code: Gate2RefusalCode };

export interface OpenedGate2 {
  readonly decisionId: string;
}

/** What the activity did once a decision exists. */
export interface Gate2Applied {
  /** The deferred specialist session continued (the PreToolUse hook then returned allow or deny). */
  readonly resumed: boolean;
  /** The session had expired, so the subtask went back to `open` for re-dispatch. */
  readonly requeued: boolean;
}

/** Counts of the subtask frontier of one run. */
export interface FrontierCounts {
  /** Approved test cases with no subtask dispatched yet and not terminal. */
  readonly eligible: number;
  /** Subtasks `open`, ready to be dispatched. */
  readonly open: number;
  /** Subtasks a specialist is working on. */
  readonly inFlight: number;
  /** Subtasks waiting on a Gate 2 decision. */
  readonly awaitingGate2: number;
  /** Subtasks `done`, `blocked`, `declined` or `model_declined`. */
  readonly terminal: number;
  /** Monotonic blackboard activity counter (tool calls, subtask updates); any increase is progress. */
  readonly activitySeq: number;
}

export interface FrontierSnapshot extends FrontierCounts {
  /** True when nothing is left to dispatch and every dispatched subtask is terminal. */
  readonly exhausted: boolean;
  /** The run reached a terminal state (killed, cancelled, failed, expired) while executing. */
  readonly runTerminal: boolean;
  /** Changes whenever the run made progress; equal markers mean no progress. */
  readonly marker: string;
}

export type OrchestratorStopReason = 'end_turn' | 'max_turns' | 'budget_exhausted';

export type ExecutionPauseReason = 'operator_pause' | 'cost_cap';

export interface ExecutionProgress {
  readonly phase: 'starting' | 'running' | 'paused' | 'completed';
  readonly sessionId: string | null;
  readonly openSubtasks: number;
  readonly inFlight: number;
  readonly gate2Pending: number;
  readonly mentorInterventions: number;
  readonly recoveries: number;
}

export interface ExecutionResult {
  readonly mentorInterventions: number;
  readonly recoveries: number;
  readonly gate2Opened: number;
  readonly gate2Approved: number;
  readonly gate2Denied: number;
  readonly terminalSubtasks: number;
}

export type MentorReason = 'stall' | 'orchestrator_request';

/** Activities the workflow calls. Every one is idempotent: Temporal may retry it. */
export interface ExecutionActivities {
  /** Applies `execution_started` when the run is `approved`; returns the frontier. */
  beginExecution(ref: ExecutionRef): Promise<FrontierSnapshot>;
  /** Starts the orchestrator session (or finds the stored one), audits `orchestrator.started`. */
  startOrchestrator(ref: ExecutionRef): Promise<{ readonly sessionId: string }>;
  /**
   * Runs (or resumes from `sessionStore`) the orchestrator until it stops. Heartbeats; a cancellation
   * interrupts the session. Throws when the session crashes.
   */
  superviseOrchestrator(
    ref: ExecutionRef & { readonly sessionId: string },
  ): Promise<{ readonly stopReason: OrchestratorStopReason }>;
  /** Stops the run's orchestrator session. Safe to repeat. */
  stopOrchestrator(ref: ExecutionRef): Promise<void>;
  /** Reads the frontier and whether the run is still alive. */
  observeFrontier(ref: ExecutionRef): Promise<FrontierSnapshot>;
  /** Reads a Gate 2 exception of the run (GATE2-001). `null` when it does not belong to the run and tenant. */
  readGate2Exception(
    ref: ExecutionRef & { readonly exceptionId: string },
  ): Promise<Gate2ExceptionSnapshot | null>;
  /**
   * Applies one event to a Gate 2 exception through the state machine (separation of duties, default deny,
   * timeout guard and audit live there). A refused person decision leaves it pending.
   */
  decideGate2Exception(
    ref: ExecutionRef & {
      readonly exceptionId: string;
      readonly event: Gate2ExceptionEvent;
      readonly actor: { readonly kind: 'user' | 'system'; readonly id: string };
      readonly reason?: string;
    },
  ): Promise<Gate2ExceptionVerdict>;
  /** Pages the on-call roster for one escalation level of a Gate 2 exception. A page is advice: it allows nothing. */
  pageGate2Escalation(
    ref: ExecutionRef & { readonly exceptionId: string; readonly level: number },
  ): Promise<void>;
  /** Supersedes every pending Gate 2 exception of the run (kill or cancel), so each one denies. Idempotent. */
  supersedeGate2Exceptions(ref: ExecutionRef): Promise<void>;
  /** Creates (or finds) the pending `gate_decisions` row, pages on-call, audits `gate2.opened`. */
  openGate2(
    ref: ExecutionRef & { readonly request: Gate2Request; readonly timeoutMinutes: number },
  ): Promise<OpenedGate2>;
  /** Decides a Gate 2 request. Approver authorisation and separation of duties are checked here. */
  decideGate2(
    ref: ExecutionRef & { readonly decisionId: string; readonly resolution: Gate2Resolution },
  ): Promise<Gate2Verdict>;
  /** Resumes the deferred session (or applies the scope exception) per the stored decision. */
  applyGate2(ref: ExecutionRef & { readonly decisionId: string }): Promise<Gate2Applied>;
  /** Denies an out-of-envelope call from a parallel batch with a reason and pauses that branch. */
  denyAndPauseBranch(
    ref: ExecutionRef & {
      readonly event: Extract<ExecutionEvent, { type: 'out_of_envelope_call' }>;
    },
  ): Promise<void>;
  /** Spins a mentor session (and a reflector after repeated failure). Advice only (§8.11). */
  requestMentor(
    ref: ExecutionRef & {
      readonly reason: MentorReason;
      readonly reflector: boolean;
      /** Stable per intervention; makes the audit event idempotent across retries. */
      readonly key: string;
    },
  ): Promise<void>;
  /** Applies `pause`, pages on-call and audits. */
  pauseRun(ref: ExecutionRef & { readonly reason: ExecutionPauseReason }): Promise<void>;
  /** Applies `resume` after an operator resumed the run. */
  resumeRun(ref: ExecutionRef & { readonly actorId: string }): Promise<void>;
  /**
   * Re-checks the frontier, then applies `validation_started` and audits `execution.completed`.
   * Refuses (value) when work remains.
   */
  completeExecution(
    ref: ExecutionRef,
  ): Promise<
    | { readonly completed: true }
    | { readonly completed: false; readonly code: 'FRONTIER_NOT_EXHAUSTED' }
  >;
  /** Kill/cancel cleanup (ORCH-013): stop the orchestrator and every specialist, deny pending gates. */
  abortExecution(ref: ExecutionRef): Promise<void>;
}
