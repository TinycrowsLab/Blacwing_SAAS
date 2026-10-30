import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  GATE2_STATES,
  GATE2_TERMINAL_STATES,
  INTRUSIVENESS_CLASSES,
  type IntrusivenessClass,
} from '@blackwing/contracts';
import { isAppError } from '@blackwing/errors';

import {
  Gate2AlreadyDecidedError,
  Gate2DestructiveForbiddenError,
  Gate2SeparationOfDutiesError,
  IllegalGate2TransitionError,
} from './errors.js';
import {
  applyGate2Event,
  describeGate2Transition,
  GATE2_EVENT_TYPES,
  GATE2_TRANSITIONS,
  type Gate2Event,
  type Gate2EventType,
  type Gate2State,
  type Gate2Status,
  type Gate2TransitionContext,
  type Gate2TransitionResult,
  gate2Allows,
  isGate2Terminal,
  nextGate2Version,
} from './state.js';

const REQUESTER = '01890a5d-ac96-774b-bcce-b302099a8001';
const PLAN_APPROVER = '01890a5d-ac96-774b-bcce-b302099a8002';
const ONCALL = '01890a5d-ac96-774b-bcce-b302099a8003';
const TIMEOUT_AT = new Date('2026-10-21T12:00:00.000Z');
const BEFORE = new Date('2026-10-21T11:59:59.999Z');
const AFTER = new Date('2026-10-21T12:00:00.000Z');

const exception = (over: Partial<Gate2Status> = {}): Gate2Status => ({
  state: 'pending',
  version: 0,
  intrusiveness: 'state_changing',
  requesterId: REQUESTER,
  planApproverId: PLAN_APPROVER,
  timeoutAt: TIMEOUT_AT,
  ...over,
});

const person = (
  id = ONCALL,
  over: Partial<Gate2TransitionContext> = {},
): Gate2TransitionContext => ({
  actor: { kind: 'user', id },
  now: BEFORE,
  reason: 'reviewed the proposed action',
  ...over,
});
const system = (now = AFTER, reason?: string): Gate2TransitionContext => ({
  actor: { kind: 'system', id: 'gate2-timer' },
  now,
  ...(reason === undefined ? {} : { reason }),
});

type Attempt =
  | { readonly kind: 'ok'; readonly result: Gate2TransitionResult }
  | { readonly kind: 'error'; readonly error: unknown };

/** Applies one event and returns the outcome as a value, so the property asserts on data, not control flow. */
function attempt(
  state: Gate2State,
  type: Gate2EventType,
  id: string,
  kind: 'user' | 'system',
  now: Date,
  intrusiveness: IntrusivenessClass,
): Attempt {
  try {
    const result = applyGate2Event(
      exception({ state, intrusiveness }),
      { type },
      { actor: { kind, id }, now, reason: 'because' },
    );
    return { kind: 'ok', result };
  } catch (error) {
    return { kind: 'error', error };
  }
}

const ctxFor = (type: Gate2EventType): Gate2TransitionContext =>
  type === 'approve' || type === 'deny' ? person() : system();

describe('Gate 2 transition table', () => {
  it('has a row for every state and no way out of a terminal state', () => {
    expect(Object.keys(GATE2_TRANSITIONS).sort()).toEqual([...GATE2_STATES].sort());
    for (const state of GATE2_TERMINAL_STATES) {
      expect(Object.keys(GATE2_TRANSITIONS[state]), state).toEqual([]);
      expect(isGate2Terminal(state)).toBe(true);
    }
    expect(isGate2Terminal('pending')).toBe(false);
  });

  it('leaves pending by exactly the four legal transitions', () => {
    expect(GATE2_TRANSITIONS.pending).toEqual({
      approve: 'approved_once',
      deny: 'denied',
      time_out: 'timed_out',
      supersede: 'superseded',
    });
  });

  it.each([
    ['approve', 'approved_once', 'approved', false, ONCALL],
    ['deny', 'denied', 'denied', false, ONCALL],
    ['time_out', 'timed_out', 'denied', true, null],
    ['supersede', 'superseded', 'denied', true, null],
  ] as const)('pending --%s--> %s', (type, to, outcome, auto, actorId) => {
    const result = applyGate2Event(exception(), { type }, ctxFor(type));
    expect(result.next).toEqual({ state: to, version: 1, decidedBy: actorId });
    expect(result.decision).toMatchObject({ gate: 2, decision: outcome, auto, actorId });
    expect(result.decision.reason.length).toBeGreaterThan(0);
    expect(result.auditIntent).toMatchObject({
      event: 'gate2.decision.recorded',
      eventType: type,
      from: 'pending',
      to,
    });
  });

  it('rejects every event from every terminal state with IllegalGate2TransitionError', () => {
    for (const state of GATE2_TERMINAL_STATES) {
      for (const type of GATE2_EVENT_TYPES) {
        const call = () => applyGate2Event(exception({ state }), { type }, ctxFor(type));
        expect(call, `${state} ${type}`).toThrow(IllegalGate2TransitionError);
      }
    }
  });

  it('rejects an unknown state or event instead of treating it as allow', () => {
    expect(() =>
      applyGate2Event(
        exception({ state: 'toString' as Gate2State }),
        { type: 'approve' },
        person(),
      ),
    ).toThrow(IllegalGate2TransitionError);
    expect(() =>
      applyGate2Event(exception(), { type: 'constructor' as Gate2EventType }, person()),
    ).toThrow(IllegalGate2TransitionError);
  });

  it('carries the registry code and names the states', () => {
    const error = (() => {
      try {
        applyGate2Event(exception({ state: 'denied' }), { type: 'approve' }, person());
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'GATE2_ILLEGAL_TRANSITION',
      from: 'denied',
      event: 'approve',
    });
  });
});

describe('approve guards', () => {
  it('refuses the requester (separation of duties, §8.4)', () => {
    expect(() => applyGate2Event(exception(), { type: 'approve' }, person(REQUESTER))).toThrow(
      Gate2SeparationOfDutiesError,
    );
  });

  it('refuses the plan approver (separation of duties, §8.4)', () => {
    expect(() => applyGate2Event(exception(), { type: 'approve' }, person(PLAN_APPROVER))).toThrow(
      Gate2SeparationOfDutiesError,
    );
  });

  it('compares ids case-insensitively', () => {
    expect(() =>
      applyGate2Event(exception(), { type: 'approve' }, person(REQUESTER.toUpperCase())),
    ).toThrow(Gate2SeparationOfDutiesError);
  });

  it('accepts a third person, also when requester and plan approver are unknown', () => {
    const open = exception({ requesterId: null, planApproverId: null });
    expect(applyGate2Event(open, { type: 'approve' }, person()).next.state).toBe('approved_once');
  });

  it('never approves a destructive exception, even for a valid approver (§8.3)', () => {
    expect(() =>
      applyGate2Event(exception({ intrusiveness: 'destructive' }), { type: 'approve' }, person()),
    ).toThrow(Gate2DestructiveForbiddenError);
  });

  it('may deny a destructive exception', () => {
    const result = applyGate2Event(
      exception({ intrusiveness: 'destructive' }),
      { type: 'deny' },
      person(),
    );
    expect(result.next.state).toBe('denied');
  });

  it('refuses a system actor and a blank actor id', () => {
    expect(() => applyGate2Event(exception(), { type: 'approve' }, system(BEFORE, 'auto'))).toThrow(
      IllegalGate2TransitionError,
    );
    expect(() => applyGate2Event(exception(), { type: 'approve' }, person('  '))).toThrow(
      IllegalGate2TransitionError,
    );
  });

  it('refuses an approval without a reason', () => {
    for (const reason of [undefined, '', '   ']) {
      const ctx =
        reason === undefined ? { actor: person().actor, now: BEFORE } : person(ONCALL, { reason });
      expect(() => applyGate2Event(exception(), { type: 'approve' }, ctx)).toThrow(
        IllegalGate2TransitionError,
      );
    }
  });

  it('refuses an approval at or after the timeout: silence is a denial', () => {
    for (const now of [AFTER, new Date('2027-01-01T00:00:00.000Z')]) {
      expect(() =>
        applyGate2Event(exception(), { type: 'approve' }, person(ONCALL, { now })),
      ).toThrow(IllegalGate2TransitionError);
    }
  });
});

describe('deny, time_out and supersede guards', () => {
  it('lets the requester deny (the safe direction)', () => {
    expect(applyGate2Event(exception(), { type: 'deny' }, person(REQUESTER)).next.state).toBe(
      'denied',
    );
  });

  it('refuses a denial from the system and without a reason', () => {
    expect(() => applyGate2Event(exception(), { type: 'deny' }, system())).toThrow(
      IllegalGate2TransitionError,
    );
    expect(() =>
      applyGate2Event(exception(), { type: 'deny' }, person(ONCALL, { reason: ' ' })),
    ).toThrow(IllegalGate2TransitionError);
  });

  it('times out only once the timeout has elapsed, and only by the system', () => {
    expect(() => applyGate2Event(exception(), { type: 'time_out' }, system(BEFORE))).toThrow(
      IllegalGate2TransitionError,
    );
    expect(() =>
      applyGate2Event(exception(), { type: 'time_out' }, person(ONCALL, { now: AFTER })),
    ).toThrow(IllegalGate2TransitionError);
    const result = applyGate2Event(exception(), { type: 'time_out' }, system(AFTER));
    expect(result.decision.reason).toMatch(/denied by default/);
    expect(result.next.decidedBy).toBeNull();
  });

  it('supersedes (run killed or cancelled) at any time, by the system only, as a denial', () => {
    expect(() => applyGate2Event(exception(), { type: 'supersede' }, person())).toThrow(
      IllegalGate2TransitionError,
    );
    const result = applyGate2Event(
      exception(),
      { type: 'supersede' },
      system(BEFORE, 'run killed'),
    );
    expect(result.next.state).toBe('superseded');
    expect(result.decision).toMatchObject({ decision: 'denied', auto: true, reason: 'run killed' });
    expect(gate2Allows(result.next.state)).toBe(false);
  });
});

describe('default deny', () => {
  it('only approved_once allows', () => {
    expect(GATE2_STATES.filter(gate2Allows)).toEqual(['approved_once']);
  });

  it('no sequence of events and actors reaches an allow without a SoD-valid person', () => {
    const states = fc.constantFrom(...GATE2_STATES);
    const events = fc.constantFrom<Gate2Event['type']>(...GATE2_EVENT_TYPES);
    const actors = fc.constantFrom(REQUESTER, PLAN_APPROVER, 'system', ONCALL);
    const kinds = fc.constantFrom<'user' | 'system'>('user', 'system');
    const times = fc.constantFrom(BEFORE, AFTER);
    const classes = fc.constantFrom(...INTRUSIVENESS_CLASSES);
    fc.assert(
      fc.property(
        states,
        events,
        actors,
        kinds,
        times,
        classes,
        (state, type, id, kind, now, intrusiveness) => {
          const outcome = attempt(state, type, id, kind, now, intrusiveness);
          const allowed = outcome.kind === 'ok' && gate2Allows(outcome.result.next.state);
          // Every allow is a pending exception, a person who is neither party, a non-destructive
          // exception and an instant before the timeout.
          const guardsHold =
            !allowed ||
            (state === 'pending' &&
              kind === 'user' &&
              ![REQUESTER, PLAN_APPROVER].includes(id) &&
              intrusiveness !== 'destructive' &&
              now.getTime() < TIMEOUT_AT.getTime());
          expect(guardsHold).toBe(true);
          expect(outcome.kind === 'ok' && outcome.result.decision.decision === 'approved').toBe(
            allowed,
          );
          expect(outcome.kind === 'error' ? isAppError(outcome.error) : true).toBe(true);
        },
      ),
    );
  });
});

describe('versioning and observability', () => {
  it('bumps the version on every accepted transition', () => {
    expect(
      applyGate2Event(exception({ version: 7 }), { type: 'deny' }, person()).next.version,
    ).toBe(8);
  });

  it('rejects a version that is not a safe non-negative integer', () => {
    for (const version of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => nextGate2Version(version)).toThrow(IllegalGate2TransitionError);
    }
  });

  it('describes a transition for the gate2.transition log line', () => {
    const { auditIntent } = applyGate2Event(exception(), { type: 'deny' }, person());
    expect(describeGate2Transition('run-1', auditIntent)).toEqual({
      runId: 'run-1',
      from: 'pending',
      to: 'denied',
      actor: ONCALL,
    });
  });
});

describe('Gate2AlreadyDecidedError', () => {
  it('is the 409 the second decider of a race receives', () => {
    const error = new Gate2AlreadyDecidedError('approved_once');
    expect(error).toMatchObject({
      code: 'GATE2_ALREADY_DECIDED',
      state: 'approved_once',
      httpStatus: 409,
    });
  });
});
