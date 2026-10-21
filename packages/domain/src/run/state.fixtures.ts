import type { RunEvent, RunEventType, RunState, RunStatus, RunTransitionContext } from './state.js';

/** A context that satisfies every guard: a different person approves, and the envelope is valid. */
export const approverCtx: RunTransitionContext = {
  actor: { kind: 'user', id: 'approver' },
  requestedBy: 'requester',
  envelopeValid: true,
};

/** A status for `state`; `paused` gets a reason and `resumeTo`. */
export function statusOf(state: RunState, version = 0): RunStatus {
  return state === 'paused'
    ? { state, reason: 'operator_pause', resumeTo: 'executing', version }
    : { state, version };
}

/** An event of `type`; `pause` gets a reason. */
export function eventOf(type: RunEventType): RunEvent {
  return type === 'pause' ? { type, reason: 'cost_cap' } : { type };
}
