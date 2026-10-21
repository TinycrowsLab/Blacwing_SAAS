import {
  type RunPauseReason,
  type RunState as ContractRunState,
  runStateSchema,
  TERMINAL_RUN_STATES,
} from '@blackwing/contracts/run';
import { ForbiddenError, IllegalRunTransitionError, ValidationError } from '@blackwing/errors';

/**
 * Run state machine (ORCH-001, F12, F7, CONTEXT_PACK §3.3).
 *
 * Pure and side-effect free: it takes and returns values, never reads the database and emits no logs.
 * The Temporal `AssessmentRunWorkflow` (ORCH-002) calls `applyTransition`, persists `next` and emits
 * the returned `auditIntent` as an `audit_events` row (§8.8).
 *
 * Optimistic concurrency contract: `runs.state_version` starts at 0 and every accepted transition
 * returns `next.version === nextVersion(current.version)`. The persistence layer must write with
 * `UPDATE runs SET state = $next, state_version = $next_version WHERE id = $id AND state_version =
 * $current_version` and treat zero updated rows as a lost race (reload and retry). Idempotent no-ops
 * return the same status object and do not bump the version.
 *
 * Error code: the registry code for a refused transition is `ILLEGAL_RUN_TRANSITION` (409), the
 * stable code the issue text calls `RUN_ILLEGAL_TRANSITION`.
 *
 * Assumptions (conservative, reversible): a rejected Gate 1 cancels the run; `cancel` is legal only
 * before execution starts and while waiting at Gate 3 (once agents may have acted, use `kill`);
 * `window_closed` stops a run that may be sending traffic (`failed`) and cancels one that has not
 * started executing.
 */

/** Run states, §3.3. Defined once in `@blackwing/contracts` so `runs.state` and this table cannot drift. */
export type RunState = ContractRunState;

/** Why an `executing` run is `paused` (§3.3). */
export type PausedReason = RunPauseReason;

/** Every run state, in graph order. */
export const RUN_STATES: readonly RunState[] = Object.freeze([...runStateSchema.options]);

/** States a run can be paused from, and therefore resumed to (`resumeTo`). */
export type PausableState = 'executing';
const PAUSABLE_STATES: readonly RunState[] = Object.freeze<RunState[]>(['executing']);

/** Events that carry no payload. */
export type SimpleRunEventType =
  | 'preflight_started'
  | 'preflight_passed'
  | 'recon_complete'
  | 'plan_proposed'
  | 'gate1_approved'
  | 'gate1_rejected'
  | 'execution_started'
  | 'resume'
  | 'validation_started'
  | 'gate3_requested'
  | 'gate3_released'
  | 'reporting_started'
  | 'completed'
  | 'cancel'
  | 'kill'
  | 'fail'
  | 'sa_expired'
  | 'window_closed';

/** Trigger of a transition. `pause` carries the reason the single `paused` state records. */
export type RunEvent =
  { readonly type: SimpleRunEventType } | { readonly type: 'pause'; readonly reason: PausedReason };

export type RunEventType = RunEvent['type'];

/** Every event type; the exhaustive matrix test iterates it. */
export const RUN_EVENT_TYPES: readonly RunEventType[] = Object.freeze<RunEventType[]>([
  'preflight_started',
  'preflight_passed',
  'recon_complete',
  'plan_proposed',
  'gate1_approved',
  'gate1_rejected',
  'execution_started',
  'pause',
  'resume',
  'validation_started',
  'gate3_requested',
  'gate3_released',
  'reporting_started',
  'completed',
  'cancel',
  'kill',
  'fail',
  'sa_expired',
  'window_closed',
]);

/**
 * A run as the state machine sees it. One `paused` state carries `reason` and `resumeTo`; it is not
 * modelled as a reason-per-state.
 */
export type RunStatus =
  | { readonly state: Exclude<RunState, 'paused'>; readonly version: number }
  | {
      readonly state: 'paused';
      readonly reason: PausedReason;
      readonly resumeTo: PausableState;
      readonly version: number;
    };

/** Who triggers a transition (placeholder for the audit actor; the workflow fills in real ids). */
export interface RunActor {
  readonly kind: 'user' | 'system';
  readonly id: string;
}

/** Facts the caller supplies for guards. The domain layer never looks anything up itself. */
export interface RunTransitionContext {
  readonly actor: RunActor;
  /** User who requested the run; the approver of Gate 1 and Gate 3 must differ (§8.4). */
  readonly requestedBy?: string;
  /** True only when Gate 1 is auto-approved because every test case is inside the standing authorisation. */
  readonly autoApproved?: boolean;
  /** True only when a valid, unexpired, verified envelope exists for the run (§8.1). */
  readonly envelopeValid?: boolean;
}

/** What the workflow must write to `audit_events` for a transition (§8.8). */
export interface RunAuditIntent {
  /** Stable audit event name, `run.<eventType>`. */
  readonly event: string;
  readonly eventType: RunEventType;
  readonly from: RunState;
  readonly to: RunState;
  readonly actor: RunActor;
  readonly reason?: PausedReason;
}

export interface TransitionResult {
  readonly next: RunStatus;
  /** `null` only for the documented idempotent no-ops, which change nothing and are not audited. */
  readonly auditIntent: RunAuditIntent | null;
}

/** Raised when the machine refuses an event. Subclass of the registry's `IllegalRunTransitionError`. */
export class IllegalRunEventError extends IllegalRunTransitionError {
  /** Event that was refused. */
  readonly eventType: string;

  constructor(from: string, eventType: string) {
    super(from, `event:${eventType}`);
    this.eventType = eventType;
  }
}

type Row = Partial<Record<RunEventType, RunState>>;

/** Legal from every non-terminal state (§8.1, §8.5): spread into each non-terminal row. */
const ANYTIME = { kill: 'killed', sa_expired: 'expired', fail: 'failed' } as const;

/**
 * Single source of truth: `transitions[from][event] = to`. For `paused`, `resume` lists the only
 * pausable source; the actual target is the status's `resumeTo`.
 */
export const transitions: Record<RunState, Row> = {
  draft: {
    preflight_started: 'preflight',
    cancel: 'cancelled',
    window_closed: 'cancelled',
    ...ANYTIME,
  },
  preflight: {
    preflight_passed: 'recon',
    cancel: 'cancelled',
    window_closed: 'cancelled',
    ...ANYTIME,
  },
  recon: { recon_complete: 'planning', cancel: 'cancelled', window_closed: 'failed', ...ANYTIME },
  planning: {
    plan_proposed: 'awaiting_gate1',
    cancel: 'cancelled',
    window_closed: 'cancelled',
    ...ANYTIME,
  },
  awaiting_gate1: {
    gate1_approved: 'approved',
    gate1_rejected: 'cancelled',
    cancel: 'cancelled',
    window_closed: 'cancelled',
    ...ANYTIME,
  },
  approved: {
    execution_started: 'executing',
    cancel: 'cancelled',
    window_closed: 'cancelled',
    ...ANYTIME,
  },
  executing: {
    pause: 'paused',
    validation_started: 'validating',
    window_closed: 'failed',
    ...ANYTIME,
  },
  paused: { resume: 'executing', cancel: 'cancelled', window_closed: 'failed', ...ANYTIME },
  validating: { gate3_requested: 'awaiting_gate3', window_closed: 'failed', ...ANYTIME },
  awaiting_gate3: { gate3_released: 'released', cancel: 'cancelled', ...ANYTIME },
  released: { reporting_started: 'reporting', ...ANYTIME },
  reporting: { completed: 'completed', ...ANYTIME },
  completed: {},
  cancelled: {},
  killed: {},
  failed: {},
  expired: {},
};

const TERMINAL: ReadonlySet<RunState> = new Set(TERMINAL_RUN_STATES);
const TRAFFIC_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'recon',
  'executing',
  'validating',
]);
const ENVELOPE_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'approved',
  'executing',
  'paused',
  'validating',
  'awaiting_gate3',
  'released',
  'reporting',
]);

/** Terminal states are absorbing (§3.3). */
export function isTerminal(state: RunState): boolean {
  return TERMINAL.has(state);
}

/** §8.1: target traffic is possible only in `recon`, `executing` and `validating`. */
export function canAcceptTargetTraffic(state: RunState): boolean {
  return TRAFFIC_STATES.has(state);
}

/** True once Gate 1 has produced the approved run envelope, until the run ends or is cut short. */
export function requiresEnvelope(state: RunState): boolean {
  return ENVELOPE_STATES.has(state);
}

/** `runs.state_version` after one accepted transition. */
export function nextVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER) {
    throw new ValidationError(
      'state_version must be a non-negative safe integer below the maximum',
      { detail: 'Invalid run state version.' },
    );
  }
  return version + 1;
}

function forbid(detail: string): never {
  throw new ForbiddenError('Run transition guard refused the event', { detail });
}

/** SoD (§8.4): the approver is known and differs from the requester; auto-approval only for Gate 1. */
function requireApprover(ctx: RunTransitionContext, allowAuto: boolean): void {
  if (ctx.actor.kind === 'system') {
    if (allowAuto && ctx.autoApproved === true) return;
    forbid('A person must approve this gate.');
  }
  if (ctx.requestedBy === undefined || ctx.requestedBy === ctx.actor.id) {
    forbid('The approver must be a different person from the requester.');
  }
}

/** §8.1: no execution without a valid envelope. */
function requireEnvelope(ctx: RunTransitionContext): void {
  if (ctx.envelopeValid !== true) forbid('No valid approved run envelope.');
}

const GUARDS: Partial<Record<RunEventType, (ctx: RunTransitionContext) => void>> = {
  gate1_approved: (ctx) => {
    requireApprover(ctx, true);
  },
  gate3_released: (ctx) => {
    requireApprover(ctx, false);
  },
  execution_started: requireEnvelope,
  resume: requireEnvelope,
};

function lookup(from: RunState, type: RunEventType): RunState | undefined {
  if (!Object.hasOwn(transitions, from)) return undefined;
  const row = transitions[from];
  return Object.hasOwn(row, type) ? row[type] : undefined;
}

/**
 * Applies `event` to `current`. Returns the next status and the audit intent, or throws
 * `IllegalRunEventError` (`ILLEGAL_RUN_TRANSITION`). Documented idempotent no-ops: `pause` while
 * paused and `kill` while killed return `current` itself with `auditIntent: null`.
 */
export function applyTransition(
  current: RunStatus,
  event: RunEvent,
  ctx: RunTransitionContext,
): TransitionResult {
  const from = current.state;
  if (
    (event.type === 'pause' && from === 'paused') ||
    (event.type === 'kill' && from === 'killed')
  ) {
    return { next: current, auditIntent: null };
  }

  const target = lookup(from, event.type);
  if (target === undefined) throw new IllegalRunEventError(from, event.type);

  GUARDS[event.type]?.(ctx);

  const version = nextVersion(current.version);
  const base = { event: `run.${event.type}`, eventType: event.type, from, actor: ctx.actor };
  if (event.type === 'pause') {
    const next: RunStatus = {
      state: 'paused',
      reason: event.reason,
      resumeTo: 'executing',
      version,
    };
    return { next, auditIntent: { ...base, to: 'paused', reason: event.reason } };
  }
  if (event.type === 'resume') {
    if (current.state !== 'paused' || !PAUSABLE_STATES.includes(current.resumeTo)) {
      throw new IllegalRunEventError(from, event.type);
    }
    const next: RunStatus = { state: current.resumeTo, version };
    return { next, auditIntent: { ...base, to: next.state } };
  }
  // Only `pause` targets `paused` (asserted by the table test), so the target is a plain state.
  const next: RunStatus = { state: target as Exclude<RunState, 'paused'>, version };
  return { next, auditIntent: { ...base, to: next.state } };
}

/** Name of the counter ORCH-002 increments per accepted transition. */
export const RUN_TRANSITIONS_METRIC = 'blackwing_run_transitions_total';
/** Label names of {@link RUN_TRANSITIONS_METRIC}. */
export const RUN_TRANSITIONS_METRIC_LABELS = ['from', 'to'] as const;

/** Fields for the caller's `pino` log line and metric labels. */
export function describeTransition(
  runId: string,
  intent: RunAuditIntent,
): { runId: string; from: RunState; to: RunState; eventType: RunEventType } {
  return { runId, from: intent.from, to: intent.to, eventType: intent.eventType };
}
