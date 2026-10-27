import {
  GATE2_TERMINAL_STATES,
  type Gate2State,
  type GateDecisionOutcome,
  type IntrusivenessClass,
} from '@blackwing/contracts';

import {
  Gate2DestructiveForbiddenError,
  Gate2SeparationOfDutiesError,
  IllegalGate2TransitionError,
} from './errors.js';

/**
 * Gate 2 exception state machine (GATE2-001, F13, F31, CONTEXT_PACK §3.2 step 8, §8.2-§8.4).
 *
 * Pure and side-effect free, like the run machine it mirrors: it takes and returns values, reads no
 * database and emits no logs. The persistence layer (`@blackwing/db` `decideGate2Exception`) calls
 * `applyGate2Event`, writes `next` with `UPDATE ... WHERE state = 'pending' AND state_version = $v`,
 * writes the returned `decision` to `gate_decisions` and emits the `auditIntent`, all in one
 * transaction. Zero updated rows is a lost race, never a retry of the decision.
 *
 * Default deny (F13, §8.2): the only transition that allows the deferred call is `pending ->
 * approved_once`, and it needs a person who is neither the requester nor the plan approver, an
 * exception that is not `destructive`, and a clock still before `timeoutAt`. The timeout, a run
 * kill or cancel, and an explicit denial all resolve to deny, and every terminal state is absorbing,
 * so no race or timer edge can turn a denial into an allow.
 */

/** Gate 2 states: defined once in `@blackwing/contracts` so the table check and this machine cannot drift. */
export type { Gate2State };

/** Triggers of a transition. */
export const GATE2_EVENT_TYPES = ['approve', 'deny', 'time_out', 'supersede'] as const;
export type Gate2EventType = (typeof GATE2_EVENT_TYPES)[number];

/** `approve` and `deny` are a person's; `time_out` is the timer's; `supersede` is the run being killed or cancelled. */
export interface Gate2Event {
  readonly type: Gate2EventType;
}

/** The exception as the state machine sees it. */
export interface Gate2Status {
  readonly state: Gate2State;
  /** `gate2_exceptions.state_version`, starts at 0; every accepted transition adds 1. */
  readonly version: number;
  readonly intrusiveness: IntrusivenessClass;
  readonly requesterId: string | null;
  readonly planApproverId: string | null;
  /** When silence becomes a denial. */
  readonly timeoutAt: Date;
}

/** Who triggers a transition. People decide; the system times out and supersedes. */
export interface Gate2Actor {
  readonly kind: 'user' | 'system';
  readonly id: string;
}

export interface Gate2TransitionContext {
  readonly actor: Gate2Actor;
  /** The authoritative instant (the database clock in the persistence layer), never a caller guess. */
  readonly now: Date;
  /** Why; mandatory for a person's decision. System events have a default. */
  readonly reason?: string;
}

/** What `gate_decisions` records (§7). */
export interface Gate2DecisionRecord {
  readonly gate: 2;
  readonly decision: GateDecisionOutcome;
  /** The deciding person; `null` for the timer and the supersede. */
  readonly actorId: string | null;
  readonly reason: string;
  /** True for the timeout and the supersede (nobody decided). */
  readonly auto: boolean;
}

/** What the writer must emit as `gate2.decision.recorded` (§8.8). */
export interface Gate2AuditIntent {
  readonly event: 'gate2.decision.recorded';
  readonly eventType: Gate2EventType;
  readonly from: Gate2State;
  readonly to: Gate2State;
  readonly actor: Gate2Actor;
  readonly reason: string;
}

export interface Gate2TransitionResult {
  readonly next: {
    readonly state: Gate2State;
    readonly version: number;
    /** `gate2_exceptions.decided_by`: the person, or `null` for a system event. */
    readonly decidedBy: string | null;
  };
  readonly decision: Gate2DecisionRecord;
  readonly auditIntent: Gate2AuditIntent;
}

/** Single source of truth: `GATE2_TRANSITIONS[from][event] = to`. Terminal states have no row entries. */
export const GATE2_TRANSITIONS: Readonly<
  Record<Gate2State, Readonly<Partial<Record<Gate2EventType, Gate2State>>>>
> = Object.freeze({
  pending: Object.freeze({
    approve: 'approved_once',
    deny: 'denied',
    time_out: 'timed_out',
    supersede: 'superseded',
  }),
  approved_once: Object.freeze({}),
  denied: Object.freeze({}),
  timed_out: Object.freeze({}),
  superseded: Object.freeze({}),
});

const TERMINAL: ReadonlySet<Gate2State> = new Set(GATE2_TERMINAL_STATES);

/** Terminal states are absorbing: a decided exception never changes. */
export function isGate2Terminal(state: Gate2State): boolean {
  return TERMINAL.has(state);
}

/**
 * True only for `approved_once`. The deferred call may run exactly when this holds; every other
 * state, including `pending`, is deny (default deny).
 */
export function gate2Allows(state: Gate2State): boolean {
  return state === 'approved_once';
}

/** `gate2_exceptions.state_version` after one accepted transition. */
export function nextGate2Version(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER) {
    throw new IllegalGate2TransitionError(
      'unknown',
      'version',
      'The Gate 2 state version must be a non-negative safe integer below the maximum.',
    );
  }
  return version + 1;
}

function lookup(from: Gate2State, type: Gate2EventType): Gate2State | undefined {
  if (!Object.hasOwn(GATE2_TRANSITIONS, from)) return undefined;
  const row = GATE2_TRANSITIONS[from];
  return Object.hasOwn(row, type) ? row[type] : undefined;
}

const same = (a: string, b: string | null): boolean =>
  b !== null && a.toLowerCase() === b.toLowerCase();

function requirePerson(ctx: Gate2TransitionContext, event: Gate2EventType, from: Gate2State): void {
  if (ctx.actor.kind !== 'user' || ctx.actor.id.trim().length === 0) {
    throw new IllegalGate2TransitionError(from, event, 'A person must make this decision.');
  }
}

function requireSystem(ctx: Gate2TransitionContext, event: Gate2EventType, from: Gate2State): void {
  if (ctx.actor.kind !== 'system') {
    throw new IllegalGate2TransitionError(from, event, 'Only the system can record this event.');
  }
}

function requireReason(
  ctx: Gate2TransitionContext,
  event: Gate2EventType,
  from: Gate2State,
): string {
  const reason = ctx.reason?.trim() ?? '';
  if (reason.length === 0) {
    throw new IllegalGate2TransitionError(from, event, 'A decision needs a recorded reason.');
  }
  return reason;
}

/**
 * Applies `event` to `current`. Returns the next status, the `gate_decisions` record and the audit
 * intent, or throws:
 * - `IllegalGate2TransitionError` (`GATE2_ILLEGAL_TRANSITION`): not a legal transition (a decided
 *   exception, an unknown state, a wrong kind of actor, an approval at or after the timeout, or a
 *   timer firing before the timeout);
 * - `Gate2DestructiveForbiddenError`: approving a `destructive` exception (§8.3);
 * - `Gate2SeparationOfDutiesError`: the approver is the requester or the plan approver (§8.4).
 */
export function applyGate2Event(
  current: Gate2Status,
  event: Gate2Event,
  ctx: Gate2TransitionContext,
): Gate2TransitionResult {
  const from = current.state;
  const to = lookup(from, event.type);
  if (to === undefined) throw new IllegalGate2TransitionError(from, event.type);

  let reason: string;
  let decision: GateDecisionOutcome;
  let auto = false;
  let decidedBy: string | null = null;
  switch (event.type) {
    case 'approve': {
      requirePerson(ctx, event.type, from);
      reason = requireReason(ctx, event.type, from);
      // Destructive first: it is blocked for everyone, whatever the approver's relationship (§8.3).
      if (current.intrusiveness === 'destructive') throw new Gate2DestructiveForbiddenError();
      if (same(ctx.actor.id, current.requesterId) || same(ctx.actor.id, current.planApproverId)) {
        throw new Gate2SeparationOfDutiesError(
          'The approver must be a different person from the requester and the plan approver.',
        );
      }
      // Silence past the timeout is a denial; a late approval must not revive the exception.
      if (ctx.now.getTime() >= current.timeoutAt.getTime()) {
        throw new IllegalGate2TransitionError(
          from,
          event.type,
          'The timeout has elapsed: the exception is denied by default.',
        );
      }
      decision = 'approved';
      decidedBy = ctx.actor.id;
      break;
    }
    case 'deny':
      requirePerson(ctx, event.type, from);
      reason = requireReason(ctx, event.type, from);
      decision = 'denied';
      decidedBy = ctx.actor.id;
      break;
    case 'time_out':
      requireSystem(ctx, event.type, from);
      if (ctx.now.getTime() < current.timeoutAt.getTime()) {
        throw new IllegalGate2TransitionError(from, event.type, 'The timeout has not elapsed yet.');
      }
      reason = ctx.reason?.trim() || 'No decision before the timeout: denied by default.';
      decision = 'denied';
      auto = true;
      break;
    case 'supersede':
      requireSystem(ctx, event.type, from);
      reason = ctx.reason?.trim() || 'The run was killed or cancelled: denied for the session.';
      decision = 'denied';
      auto = true;
      break;
  }

  return {
    next: { state: to, version: nextGate2Version(current.version), decidedBy },
    decision: { gate: 2, decision, actorId: decidedBy, reason, auto },
    auditIntent: {
      event: 'gate2.decision.recorded',
      eventType: event.type,
      from,
      to,
      actor: ctx.actor,
      reason,
    },
  };
}

/** Name of the counter incremented per created or decided exception, labelled by state. */
export const GATE2_EXCEPTIONS_METRIC = 'gate2_exceptions_total';
/** Label names of {@link GATE2_EXCEPTIONS_METRIC}. */
export const GATE2_EXCEPTIONS_METRIC_LABELS = ['state'] as const;
/** Structured log event name of an accepted transition. */
export const GATE2_TRANSITION_LOG = 'gate2.transition';

/** Fields for the caller's `gate2.transition` log line (`runId`, `from`, `to`, `actor`). */
export function describeGate2Transition(
  runId: string,
  intent: Gate2AuditIntent,
): { runId: string; from: Gate2State; to: Gate2State; actor: string } {
  return { runId, from: intent.from, to: intent.to, actor: intent.actor.id };
}
