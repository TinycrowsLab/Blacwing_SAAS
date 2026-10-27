import { describe, expect, it } from 'vitest';

import {
  canKillRun,
  formatMs,
  isKillConfirmed,
  isKillInFlight,
  isRunEnded,
  isWithinHaltSlo,
  totalHaltMs,
  type KillEventView,
} from './kill-model';

const event = (over: Partial<KillEventView> = {}): KillEventView => ({
  status: 'halted',
  initiatedAt: '2026-10-20T10:00:00.000Z',
  gatewayBlockedMs: 400,
  sandboxesTerminatedMs: 3100,
  completedAt: '2026-10-20T10:00:03.300Z',
  actor: 'Priya Nair',
  ...over,
});

describe('canKillRun', () => {
  it('allows the roles holding kill:trigger', () => {
    expect(canKillRun(['appsec_engineer'], false)).toBe(true);
    expect(canKillRun(['org_admin'], false)).toBe(true);
  });

  it('lets an asset owner kill only on assets they own', () => {
    expect(canKillRun(['asset_owner'], false)).toBe(false);
    expect(canKillRun(['asset_owner'], true)).toBe(true);
  });

  it('denies roles without the permission, unknown roles and no roles', () => {
    expect(canKillRun(['developer'], true)).toBe(false);
    expect(canKillRun(['auditor'], true)).toBe(false);
    expect(canKillRun(['kill_everything'], true)).toBe(false);
    expect(canKillRun([], true)).toBe(false);
  });

  it('allows when any one role qualifies', () => {
    expect(canKillRun(['developer', 'appsec_engineer'], false)).toBe(true);
  });
});

describe('isRunEnded', () => {
  it.each(['completed', 'released', 'killed', 'cancelled', 'failed', 'expired'] as const)(
    'treats %s as ended',
    (state) => {
      expect(isRunEnded({ state, killEvent: null })).toBe(true);
    },
  );

  it.each(['executing', 'paused', 'validating', 'recon', 'awaiting_gate3'] as const)(
    'keeps %s killable',
    (state) => {
      expect(isRunEnded({ state, killEvent: null })).toBe(false);
    },
  );

  it('treats a fully halted kill as ended, but a partial one as retryable', () => {
    expect(isRunEnded({ state: 'executing', killEvent: event() })).toBe(true);
    expect(
      isRunEnded({ state: 'executing', killEvent: event({ status: 'partially_halted' }) }),
    ).toBe(false);
  });
});

describe('isKillInFlight', () => {
  it('is false with no kill and no accepted request', () => {
    expect(isKillInFlight(null, null)).toBe(false);
  });

  it('follows a kill someone else started (stream kill.initiated)', () => {
    expect(
      isKillInFlight(
        event({ status: 'initiated', completedAt: null, gatewayBlockedMs: null }),
        null,
      ),
    ).toBe(true);
    expect(isKillInFlight(event({ status: 'propagating', completedAt: null }), null)).toBe(true);
  });

  it('keeps showing killing after our 202 until the server completes that event', () => {
    const accepted = '2026-10-20T10:00:00.000Z';
    expect(isKillInFlight(null, accepted)).toBe(true);
    expect(isKillInFlight(event({ status: 'initiated', completedAt: null }), accepted)).toBe(true);
    expect(isKillInFlight(event(), accepted)).toBe(false);
  });

  it('ignores an older, already settled kill event after a new request was accepted', () => {
    const old = event({ status: 'failed', initiatedAt: '2026-10-20T09:00:00.000Z' });
    expect(isKillInFlight(old, '2026-10-20T10:00:00.000Z')).toBe(true);
    expect(isKillInFlight(old, null)).toBe(false);
  });
});

describe('isKillConfirmed', () => {
  const id = 'run_01jbz3k6w8f5r4t2n9q7x0m1ab';
  it('requires the exact public run id', () => {
    expect(isKillConfirmed(id, id)).toBe(true);
    expect(isKillConfirmed(`  ${id}\n`, id)).toBe(true);
    expect(isKillConfirmed(id.toUpperCase(), id)).toBe(false);
    expect(isKillConfirmed(id.slice(0, -1), id)).toBe(false);
    expect(isKillConfirmed('', id)).toBe(false);
    expect(isKillConfirmed('', '')).toBe(false);
  });
});

describe('halt time', () => {
  it('derives the total from the server timestamps only once completed', () => {
    expect(totalHaltMs(event())).toBe(3300);
    expect(totalHaltMs(event({ completedAt: null }))).toBeNull();
    expect(totalHaltMs(event({ completedAt: '2026-10-20T09:59:00.000Z' }))).toBeNull();
    expect(totalHaltMs(event({ completedAt: 'not a date' }))).toBeNull();
  });

  it('is within SLO only below 2s gateway and 10s sandbox, strictly', () => {
    expect(isWithinHaltSlo(event({ gatewayBlockedMs: 1999, sandboxesTerminatedMs: 9999 }))).toBe(
      true,
    );
    expect(isWithinHaltSlo(event({ gatewayBlockedMs: 2000 }))).toBe(false);
    expect(isWithinHaltSlo(event({ sandboxesTerminatedMs: 10_000 }))).toBe(false);
    expect(isWithinHaltSlo(event({ gatewayBlockedMs: null }))).toBe(false);
    expect(isWithinHaltSlo(event({ sandboxesTerminatedMs: null }))).toBe(false);
    expect(isWithinHaltSlo(event({ status: 'partially_halted' }))).toBe(false);
  });

  it('formats milliseconds and seconds', () => {
    expect(formatMs(820)).toBe('820 ms');
    expect(formatMs(3300)).toBe('3.3 s');
    expect(formatMs(1000)).toBe('1.0 s');
  });
});
