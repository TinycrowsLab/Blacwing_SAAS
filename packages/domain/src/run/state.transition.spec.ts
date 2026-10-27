import { describe, expect, it } from 'vitest';

import {
  ForbiddenError,
  IllegalRunTransitionError,
  isAppError,
  ValidationError,
} from '@blackwing/errors';

import { approverCtx, eventOf, statusOf } from './state.fixtures.js';
import {
  applyTransition,
  describeTransition,
  IllegalRunEventError,
  nextVersion,
  RUN_EVENT_TYPES,
  RUN_STATES,
  RUN_TRANSITIONS_METRIC,
  RUN_TRANSITIONS_METRIC_LABELS,
  type RunEventType,
  type RunState,
  type RunStatus,
  transitions,
} from './state.js';

const apply = (from: RunState | RunStatus, type: RunEventType, ctx = approverCtx) =>
  applyTransition(typeof from === 'string' ? statusOf(from) : from, eventOf(type), ctx);

describe('transition matrix', () => {
  it('has a row for every state', () => {
    expect(Object.keys(transitions).sort()).toEqual([...RUN_STATES].sort());
  });

  it('decides every (state, event) pair: in the table it succeeds, otherwise it throws', () => {
    for (const from of RUN_STATES) {
      for (const type of RUN_EVENT_TYPES) {
        const listed = Object.hasOwn(transitions[from], type);
        const idempotent =
          (type === 'pause' && from === 'paused') || (type === 'kill' && from === 'killed');
        const run = () => applyTransition(statusOf(from, 4), eventOf(type), approverCtx);
        const outcome =
          listed || idempotent
            ? idempotent
              ? from
              : type === 'resume'
                ? 'executing'
                : transitions[from][type]
            : 'throws';
        const actual = (() => {
          try {
            return run().next.state;
          } catch (error) {
            return error instanceof IllegalRunEventError ? 'throws' : 'unexpected error';
          }
        })();
        expect(actual, `${from} + ${type}`).toBe(outcome);
      }
    }
  });

  it('only pause targets paused, and terminal rows are empty', () => {
    for (const from of RUN_STATES) {
      for (const [type, to] of Object.entries(transitions[from])) {
        expect(to === 'paused' ? type : 'pause').toBe('pause');
      }
    }
    for (const t of ['completed', 'cancelled', 'killed', 'failed', 'expired'] as const) {
      expect(transitions[t]).toEqual({});
    }
  });

  it('walks the happy path draft to completed, bumping the version and emitting audit intents', () => {
    const steps: [RunEventType, RunState][] = [
      ['preflight_started', 'preflight'],
      ['preflight_passed', 'recon'],
      ['recon_complete', 'planning'],
      ['plan_proposed', 'awaiting_gate1'],
      ['gate1_approved', 'approved'],
      ['execution_started', 'executing'],
      ['validation_started', 'validating'],
      ['gate3_requested', 'awaiting_gate3'],
      ['gate3_released', 'released'],
      ['reporting_started', 'reporting'],
      ['completed', 'completed'],
    ];
    let status = statusOf('draft');
    steps.forEach(([type, to], i) => {
      const result = apply(status, type);
      expect(result.next).toEqual({ state: to, version: i + 1 });
      expect(result.auditIntent).toEqual({
        event: `run.${type}`,
        eventType: type,
        from: status.state,
        to,
        actor: approverCtx.actor,
      });
      status = result.next;
    });
  });

  it('cancels on gate1_rejected, on cancel before execution and on window_closed before execution', () => {
    expect(apply('awaiting_gate1', 'gate1_rejected').next.state).toBe('cancelled');
    expect(apply('draft', 'cancel').next.state).toBe('cancelled');
    expect(apply('awaiting_gate3', 'cancel').next.state).toBe('cancelled');
    expect(apply('approved', 'window_closed').next.state).toBe('cancelled');
    expect(apply('executing', 'window_closed').next.state).toBe('failed');
    expect(() => apply('executing', 'cancel')).toThrow(IllegalRunEventError);
  });
});

describe('Gate 1 re-plan', () => {
  it('sends a rejected plan back to planning, bumping the version, and the loop can run again', () => {
    const replan = apply(statusOf('awaiting_gate1', 3), 'gate1_replan');
    expect(replan.next).toEqual({ state: 'planning', version: 4 });
    expect(replan.auditIntent).toMatchObject({ event: 'run.gate1_replan', to: 'planning' });
    expect(apply(replan.next, 'plan_proposed').next.state).toBe('awaiting_gate1');
  });

  it('is legal only at Gate 1', () => {
    for (const from of RUN_STATES.filter((s) => s !== 'awaiting_gate1')) {
      expect(() => apply(from, 'gate1_replan'), from).toThrow(IllegalRunEventError);
    }
  });
});

describe('errors', () => {
  it('throws a typed AppError with the stable code, from and eventType', () => {
    let caught: unknown;
    try {
      apply('executing', 'gate1_approved');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IllegalRunEventError);
    expect(caught).toBeInstanceOf(IllegalRunTransitionError);
    expect(isAppError(caught)).toBe(true);
    const error = caught as IllegalRunEventError;
    expect(error.code).toBe('ILLEGAL_RUN_TRANSITION');
    expect(error.httpStatus).toBe(409);
    expect(error.from).toBe('executing');
    expect(error.eventType).toBe('gate1_approved');
  });

  it('refuses a double transition: the second call is not legal from the new state', () => {
    const first = apply('draft', 'preflight_started');
    expect(() => apply(first.next, 'preflight_started')).toThrow(IllegalRunEventError);
  });

  it('falls back to RUN illegal transition for an unknown event type or state at run time', () => {
    const unknownEvent = { type: 'teleport' } as unknown as Parameters<typeof applyTransition>[1];
    expect(() => applyTransition(statusOf('draft'), unknownEvent, approverCtx)).toThrow(
      IllegalRunEventError,
    );
    const protoEvent = { type: 'constructor' } as unknown as Parameters<typeof applyTransition>[1];
    expect(() => applyTransition(statusOf('draft'), protoEvent, approverCtx)).toThrow(
      IllegalRunEventError,
    );
    const unknownState = { state: 'limbo', version: 0 } as unknown as RunStatus;
    expect(() => apply(unknownState, 'kill')).toThrow(IllegalRunEventError);
  });

  it('refuses resume from a malformed paused status that lost its resumeTo', () => {
    const broken = { state: 'paused', reason: 'cost_cap', version: 1 } as unknown as RunStatus;
    expect(() => apply(broken, 'resume')).toThrow(IllegalRunEventError);
  });
});

describe('guards', () => {
  it('Gate 1 needs a person other than the requester (separation of duties)', () => {
    const at = statusOf('awaiting_gate1');
    expect(apply(at, 'gate1_approved').next.state).toBe('approved');
    const self = { ...approverCtx, actor: { kind: 'user', id: 'requester' } } as const;
    expect(() => apply(at, 'gate1_approved', self)).toThrow(ForbiddenError);
    const unknownRequester = { actor: approverCtx.actor, envelopeValid: true };
    expect(() => apply(at, 'gate1_approved', unknownRequester)).toThrow(ForbiddenError);
  });

  it('Gate 1 may be auto-approved by the system only when flagged, Gate 3 never', () => {
    const system = { ...approverCtx, actor: { kind: 'system', id: 'workflow' } } as const;
    expect(() => apply('awaiting_gate1', 'gate1_approved', system)).toThrow(ForbiddenError);
    expect(
      apply('awaiting_gate1', 'gate1_approved', { ...system, autoApproved: true }).next.state,
    ).toBe('approved');
    expect(() =>
      apply('awaiting_gate3', 'gate3_released', { ...system, autoApproved: true }),
    ).toThrow(ForbiddenError);
    expect(apply('awaiting_gate3', 'gate3_released').next.state).toBe('released');
  });

  it('refuses to start or resume execution without a valid envelope (§8.1)', () => {
    const noEnvelope = { actor: approverCtx.actor };
    expect(() => apply('approved', 'execution_started', noEnvelope)).toThrow(ForbiddenError);
    expect(() => apply('paused', 'resume', { ...approverCtx, envelopeValid: false })).toThrow(
      ForbiddenError,
    );
  });

  it('a guard failure does not hide an illegal transition and illegal events skip guards', () => {
    expect(() => apply('executing', 'gate1_approved', { actor: approverCtx.actor })).toThrow(
      IllegalRunEventError,
    );
  });
});

describe('versioning, audit and observability helpers', () => {
  it('bumps the version by one and rejects invalid versions', () => {
    expect(nextVersion(0)).toBe(1);
    expect(nextVersion(41)).toBe(42);
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => nextVersion(bad)).toThrow(ValidationError);
    }
  });

  it('describes a transition with the pino fields and exposes the metric constants', () => {
    const { auditIntent } = apply('draft', 'preflight_started');
    expect(auditIntent).not.toBeNull();
    if (auditIntent === null) return;
    expect(describeTransition('run-1', auditIntent)).toEqual({
      runId: 'run-1',
      from: 'draft',
      to: 'preflight',
      eventType: 'preflight_started',
    });
    expect(RUN_TRANSITIONS_METRIC).toBe('blackwing_run_transitions_total');
    expect(RUN_TRANSITIONS_METRIC_LABELS).toEqual(['from', 'to']);
  });
});
