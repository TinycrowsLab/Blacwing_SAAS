import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import {
  addDays,
  addHours,
  decideAfterProbe,
  IllegalVerificationTransitionError,
  isChallengeExpired,
  transitionVerification,
  VERIFICATION_EVENT_TYPES,
  VERIFICATION_TRANSITIONS,
} from './machine.js';

describe('transitionVerification', () => {
  it.each([
    ['unverified', 'start', 'pending'],
    ['pending', 'restart', 'pending'],
    ['pending', 'pass', 'verified'],
    ['pending', 'fail', 'unverified'],
    ['pending', 'expire', 'unverified'],
    ['pending', 'cancel', 'unverified'],
    ['pending', 'reject', 'rejected'],
  ] as const)('moves %s on %s to %s', (from, event, to) => {
    expect(transitionVerification(from, event)).toBe(to);
  });

  it('refuses to verify a rejected asset (the issue example)', () => {
    expect(() => transitionVerification('rejected', 'pass')).toThrow(
      IllegalVerificationTransitionError,
    );
  });

  it.each([
    ['verified', 'start'],
    ['verified', 'pass'],
    ['verified', 'cancel'],
    ['rejected', 'start'],
    ['rejected', 'restart'],
    ['unverified', 'pass'],
    ['unverified', 'cancel'],
    ['unverified', 'restart'],
    ['pending', 'start'],
  ] as const)('refuses %s on %s with the 409 code', (from, event) => {
    let thrown: unknown;
    try {
      transitionVerification(from, event);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IllegalVerificationTransitionError);
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      code: 'ASSET_VERIFICATION_ILLEGAL_TRANSITION',
      httpStatus: 409,
      from,
      eventType: event,
    });
  });

  it('refuses an unknown event string (fail closed, never a silent pass)', () => {
    expect(() => transitionVerification('pending', 'constructor' as never)).toThrow(
      IllegalVerificationTransitionError,
    );
    expect(() => transitionVerification('pending', '__proto__' as never)).toThrow(
      IllegalVerificationTransitionError,
    );
  });

  it('has a rule for every event, and no event leads to verified except pass', () => {
    expect(Object.keys(VERIFICATION_TRANSITIONS).toSorted()).toEqual(
      [...VERIFICATION_EVENT_TYPES].toSorted(),
    );
    const intoVerified = VERIFICATION_EVENT_TYPES.filter(
      (event) => VERIFICATION_TRANSITIONS[event].to === 'verified',
    );
    expect(intoVerified).toEqual(['pass']);
  });
});

describe('isChallengeExpired', () => {
  const expiresAt = new Date('2026-11-01T00:00:00.000Z');

  it('is not expired before the instant and expired from it on', () => {
    expect(isChallengeExpired(expiresAt, new Date('2026-10-31T23:59:59.999Z'))).toBe(false);
    expect(isChallengeExpired(expiresAt, expiresAt)).toBe(true);
    expect(isChallengeExpired(expiresAt, new Date('2026-11-02T00:00:00.000Z'))).toBe(true);
  });
});

describe('addHours and addDays (UTC arithmetic)', () => {
  it('adds exact 24-hour days across a daylight-saving change in a local zone', () => {
    // 2026-03-28 is the last Sunday of March in Europe: the local day is 23 hours long, UTC is not.
    const start = new Date('2026-03-27T12:00:00.000Z');
    expect(addDays(start, 1).toISOString()).toBe('2026-03-28T12:00:00.000Z');
  });

  it('adds the configured TTL: 90 days and 72 hours', () => {
    const now = new Date('2026-10-30T10:00:00.000Z');
    expect(addDays(now, 90).toISOString()).toBe('2027-01-28T10:00:00.000Z');
    expect(addHours(now, 72).toISOString()).toBe('2026-11-02T10:00:00.000Z');
  });
});

describe('decideAfterProbe', () => {
  it('passes on a found token whatever the attempt count', () => {
    expect(decideAfterProbe(true, 1, 20)).toBe('passed');
    expect(decideAfterProbe(true, 20, 20)).toBe('passed');
  });

  it('keeps the challenge open below the budget and spends it at the budget', () => {
    expect(decideAfterProbe(false, 1, 3)).toBe('retry');
    expect(decideAfterProbe(false, 2, 3)).toBe('retry');
    expect(decideAfterProbe(false, 3, 3)).toBe('exhausted');
  });

  it('spends a budget of one on the first miss', () => {
    expect(decideAfterProbe(false, 1, 1)).toBe('exhausted');
  });
});
