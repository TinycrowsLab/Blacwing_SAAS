import { describe, expect, it } from 'vitest';

import { SA_STATUSES, type SaStatus } from '@blackwing/contracts';
import { ForbiddenError, isAppError, ValidationError } from '@blackwing/errors';

import {
  IllegalSaTransitionError,
  SA_EVENT_TYPES,
  SA_TRANSITIONS,
  type SaActor,
  type SaEventType,
  type SaState,
  type SaTransitionContext,
  transitionSa,
} from './state.js';

const REQUESTER = '0190f6a2-7b1c-7d2e-8f3a-000000000001';
const APPROVER = '0190f6a2-7b1c-7d2e-8f3a-000000000002';
const EXPIRES_AT = new Date('2026-12-31T00:00:00.000Z');
const BEFORE_EXPIRY = new Date('2026-10-28T12:00:00.000Z');

const person = (id = APPROVER): SaActor => ({ kind: 'user', id });

/** A standing authorisation in `status`; frozen, so any mutation by the machine would throw. */
function sa(status: SaStatus, overrides: Partial<SaState> = {}): SaState {
  return Object.freeze({
    status,
    version: 3,
    requesterId: REQUESTER,
    approverId: null,
    expiresAt: EXPIRES_AT,
    revocationReason: null,
    ...overrides,
  });
}

function ctx(overrides: Partial<SaTransitionContext> = {}): SaTransitionContext {
  return { actor: person(), now: BEFORE_EXPIRY, ...overrides };
}

/** A context that satisfies every guard of `event`, so only the state can refuse it. */
const satisfyingCtx: Record<SaEventType, SaTransitionContext> = {
  submit: ctx(),
  approve: ctx(),
  reject: ctx(),
  expire: ctx({ now: EXPIRES_AT }),
  revoke: ctx({ revocationReason: 'customer withdrew consent' }),
};

/** Runs `fn` and returns what it threw, so a test can inspect the error's code and status. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('transition table', () => {
  it('lists exactly the five legal transitions of AUTHZ-001', () => {
    expect(SA_TRANSITIONS).toEqual({
      submit: { from: 'draft', to: 'pending_approval' },
      approve: { from: 'pending_approval', to: 'active' },
      reject: { from: 'pending_approval', to: 'draft' },
      expire: { from: 'active', to: 'expired' },
      revoke: { from: 'active', to: 'revoked' },
    });
  });
});

describe('legal transitions', () => {
  it.each(SA_EVENT_TYPES)(
    '%s moves to its target state, bumps the version and is audited',
    (event) => {
      const { from, to } = SA_TRANSITIONS[event];
      const result = transitionSa(sa(from), event, satisfyingCtx[event]);

      expect(result.next.status).toBe(to);
      expect(result.next.version).toBe(4);
      expect(result.auditIntent).toEqual({
        event: 'authz.sa.state_changed',
        eventType: event,
        from,
        to,
        actor: satisfyingCtx[event].actor,
      });
    },
  );

  it('approve records the approver and keeps the requester', () => {
    const { next } = transitionSa(sa('pending_approval'), 'approve', ctx());
    expect(next.approverId).toBe(APPROVER);
    expect(next.requesterId).toBe(REQUESTER);
  });

  it('reject returns to draft without recording an approver', () => {
    const { next } = transitionSa(sa('pending_approval'), 'reject', ctx());
    expect(next.status).toBe('draft');
    expect(next.approverId).toBeNull();
  });

  it('submit by the requester moves the record to pending approval', () => {
    const { next } = transitionSa(sa('draft'), 'submit', ctx({ actor: person(REQUESTER) }));
    expect(next.status).toBe('pending_approval');
  });
});

describe('illegal transitions are refused', () => {
  const cases = SA_STATUSES.flatMap((status) =>
    SA_EVENT_TYPES.filter((event) => SA_TRANSITIONS[event].from !== status).map(
      (event) => [status, event] as const,
    ),
  );

  it.each(cases)('%s refuses %s with AUTHZ_ILLEGAL_TRANSITION (409)', (status, event) => {
    const error = thrownBy(() => transitionSa(sa(status), event, satisfyingCtx[event]));

    expect(error).toBeInstanceOf(IllegalSaTransitionError);
    expect(isAppError(error)).toBe(true);
    if (!(error instanceof IllegalSaTransitionError)) return;
    expect(error.code).toBe('AUTHZ_ILLEGAL_TRANSITION');
    expect(error.httpStatus).toBe(409);
    expect(error.from).toBe(status);
    expect(error.eventType).toBe(event);
  });

  it('treats expired and revoked as terminal: every event is refused', () => {
    for (const status of ['expired', 'revoked'] as const) {
      for (const event of SA_EVENT_TYPES) {
        expect(() => transitionSa(sa(status), event, satisfyingCtx[event])).toThrow(
          IllegalSaTransitionError,
        );
      }
    }
  });

  it.each(['destroy', 'constructor', 'toString', '__proto__', ''])(
    'refuses an unknown event %j instead of crashing',
    (event) => {
      expect(() => transitionSa(sa('active'), event as SaEventType, ctx())).toThrow(
        IllegalSaTransitionError,
      );
    },
  );
});

describe('separation of duties (§8.4)', () => {
  it('refuses approval by the requester and leaves the state untouched', () => {
    const error = thrownBy(() =>
      transitionSa(sa('pending_approval'), 'approve', ctx({ actor: person(REQUESTER) })),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).httpStatus).toBe(403);
  });

  it('refuses rejection by the requester', () => {
    expect(() =>
      transitionSa(sa('pending_approval'), 'reject', ctx({ actor: person(REQUESTER) })),
    ).toThrow(ForbiddenError);
  });

  it.each(['approve', 'reject'] as const)(
    'refuses %s by the system: a person must decide',
    (event) => {
      const system: SaActor = { kind: 'system', id: 'scheduler' };
      expect(() => transitionSa(sa('pending_approval'), event, ctx({ actor: system }))).toThrow(
        ForbiddenError,
      );
    },
  );
});

describe('expiry', () => {
  it('refuses to expire before expires_at', () => {
    const justBefore = new Date(EXPIRES_AT.getTime() - 1);
    expect(() => transitionSa(sa('active'), 'expire', ctx({ now: justBefore }))).toThrow(
      IllegalSaTransitionError,
    );
  });

  it('expires exactly at expires_at and after it', () => {
    expect(transitionSa(sa('active'), 'expire', ctx({ now: EXPIRES_AT })).next.status).toBe(
      'expired',
    );
    const later = new Date(EXPIRES_AT.getTime() + 60_000);
    expect(transitionSa(sa('active'), 'expire', ctx({ now: later })).next.status).toBe('expired');
  });

  it('fails closed on an invalid clock: a NaN now never expires the record', () => {
    expect(() =>
      transitionSa(sa('active'), 'expire', ctx({ now: new Date('not a date') })),
    ).toThrow(IllegalSaTransitionError);
  });

  it('lets the system (scheduler) expire a record once its window has ended', () => {
    const scheduler: SaActor = { kind: 'system', id: 'scheduler' };
    expect(
      transitionSa(sa('active'), 'expire', ctx({ actor: scheduler, now: EXPIRES_AT })).next.status,
    ).toBe('expired');
  });
});

describe('revocation', () => {
  it.each([undefined, '', '   ', '\t\n'])('requires a non-blank reason (%j)', (reason) => {
    const error = thrownBy(() =>
      transitionSa(sa('active'), 'revoke', ctx({ revocationReason: reason })),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe('VALIDATION_FAILED');
  });

  it('stores the trimmed reason and keeps the approver of record', () => {
    const { next } = transitionSa(
      sa('active', { approverId: APPROVER }),
      'revoke',
      ctx({ revocationReason: '  leaked credentials  ' }),
    );
    expect(next.status).toBe('revoked');
    expect(next.revocationReason).toBe('leaked credentials');
    expect(next.approverId).toBe(APPROVER);
  });

  it('cannot revoke a record that is still pending approval', () => {
    expect(() =>
      transitionSa(sa('pending_approval'), 'revoke', ctx({ revocationReason: 'too early' })),
    ).toThrow(IllegalSaTransitionError);
  });
});

describe('versioning and purity', () => {
  it('starts from the given version and never reuses one', () => {
    expect(transitionSa(sa('draft', { version: 1 }), 'submit', ctx()).next.version).toBe(2);
    expect(transitionSa(sa('draft', { version: 0 }), 'submit', ctx()).next.version).toBe(1);
  });

  it('refuses a corrupt version instead of wrapping it', () => {
    expect(() =>
      transitionSa(sa('draft', { version: Number.MAX_SAFE_INTEGER }), 'submit', ctx()),
    ).toThrow(ValidationError);
    expect(() => transitionSa(sa('draft', { version: -1 }), 'submit', ctx())).toThrow(
      ValidationError,
    );
  });

  it('never mutates the input record', () => {
    const before = sa('active', { approverId: APPROVER });
    const snapshot = structuredClone(before);
    transitionSa(before, 'revoke', ctx({ revocationReason: 'withdrawn' }));
    expect(before).toEqual(snapshot);
  });
});
