import { describe, expect, it } from 'vitest';

import { makeHarness } from './testing.js';

import type { SaTimeBounds } from './types.js';

const HOUR = 3_600_000;
const nightly = (expiresAt: string): SaTimeBounds => ({
  validFrom: '2026-01-01T00:00:00.000Z',
  expiresAt,
  testWindows: [{ cron: '0 22 * * *', timezone: 'Europe/London', durationMs: 4 * HOUR }],
});
const always = (expiresAt: string): SaTimeBounds => ({
  validFrom: '2026-01-01T00:00:00.000Z',
  expiresAt,
  testWindows: [],
});

describe('SA expiry mid-run', () => {
  it('blocks egress first, then cancels sessions, then finalises the run as expired', async () => {
    const h = makeHarness({
      bounds: always('2026-06-01T12:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
    });
    await h.run();

    expect(h.calls).toEqual([
      'egress.block:sa_expired',
      'audit:egress.blocked',
      'sessions.cancel',
      'run.expire:sa_expired',
      'audit:sa.expired',
    ]);
    expect(h.lifecycle.state).toBe('expired');
    expect(h.status.current).toMatchObject({ phase: 'stopped', stoppedFor: 'sa_expired' });
    // The timer fired at the expiry instant, not before.
    expect(h.clock.ms).toBe(new Date('2026-06-01T12:00:00.000Z').getTime());
    expect(h.metrics.expiry).toEqual(['sa_expired']);
    expect(h.metrics.latencies).toHaveLength(1);
    expect(h.metrics.latencies[0]).toBeLessThan(1);
  });

  it('no session cancellation or state change happens before the egress block is acknowledged', async () => {
    const h = makeHarness({
      bounds: always('2026-06-01T12:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
    });
    await h.run();
    const block = h.calls.indexOf('egress.block:sa_expired');
    expect(block).toBe(0);
    expect(h.calls.indexOf('sessions.cancel')).toBeGreaterThan(block);
    expect(h.calls.indexOf('run.expire:sa_expired')).toBeGreaterThan(block);
  });

  it('still cancels sessions and finalises when the gateway ack is missing (gateway fails closed)', async () => {
    const h = makeHarness({
      bounds: always('2026-06-01T12:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
    });
    h.failEgress.times = 1;
    await h.run();
    expect(h.calls.slice(0, 3)).toEqual([
      'egress.block:sa_expired',
      'audit:egress.blocked',
      'sessions.cancel',
    ]);
    expect(h.audits[0]?.details).toMatchObject({ outcome: 'unconfirmed' });
    expect(h.lifecycle.state).toBe('expired');
  });

  it('finalises even when session cancellation fails', async () => {
    const h = makeHarness({
      bounds: always('2026-06-01T12:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
    });
    h.failCancel.on = true;
    await h.run();
    expect(h.lifecycle.state).toBe('expired');
  });

  it('audits egress.blocked with reason sa_expired and sa.expired', async () => {
    const h = makeHarness({
      bounds: always('2026-06-01T12:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
    });
    await h.run();
    expect(h.audits.map((a) => a.event)).toEqual(['egress.blocked', 'sa.expired']);
    expect(h.audits[0]?.details).toMatchObject({ reason: 'sa_expired', outcome: 'blocked' });
  });

  it('an SA already expired at start stops immediately', async () => {
    const h = makeHarness({
      bounds: always('2026-06-01T09:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
    });
    await h.run();
    expect(h.calls[0]).toBe('egress.block:sa_expired');
    expect(h.lifecycle.state).toBe('expired');
  });

  it('is ignored for a run that is already terminal (timer fires after the run ended)', async () => {
    const h = makeHarness({
      bounds: always('2026-06-01T12:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
      runState: 'killed',
    });
    await h.run();
    expect(h.lifecycle.state).toBe('killed');
  });

  it('stands down without touching anything when the run finished first', async () => {
    const h = makeHarness({
      bounds: always('2026-06-01T12:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
    });
    h.at('2026-06-01T11:00:00.000Z', (s) => {
      s.finished = true;
    });
    await h.run();
    expect(h.calls).toEqual([]);
    expect(h.status.current.phase).toBe('finished');
  });

  it('extending expiry by an edit moves the timer; shortening it expires sooner', async () => {
    const longer = makeHarness({
      bounds: always('2026-06-01T12:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
    });
    longer.at('2026-06-01T11:00:00.000Z', (s) => {
      s.bounds = always('2026-06-01T15:00:00.000Z');
    });
    await longer.run();
    expect(longer.clock.ms).toBe(new Date('2026-06-01T15:00:00.000Z').getTime());

    const shorter = makeHarness({
      bounds: always('2026-06-01T12:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
    });
    shorter.at('2026-06-01T10:30:00.000Z', (s) => {
      s.bounds = always('2026-06-01T11:00:00.000Z');
    });
    await shorter.run();
    expect(shorter.clock.ms).toBe(new Date('2026-06-01T11:00:00.000Z').getTime());
    expect(shorter.lifecycle.state).toBe('expired');
  });

  it('survives a long wait by re-evaluating (timers are capped, expiry is still exact)', async () => {
    const h = makeHarness({
      bounds: always('2026-06-30T00:00:00.000Z'),
      start: '2026-06-01T00:00:00.000Z',
    });
    await h.run();
    expect(h.clock.ms).toBe(new Date('2026-06-30T00:00:00.000Z').getTime());
    expect(h.lifecycle.state).toBe('expired');
  });
});

describe('SA revocation mid-run', () => {
  it('behaves like expiry: egress blocked first, sessions cancelled, run expired', async () => {
    const h = makeHarness({
      bounds: always('2026-06-30T00:00:00.000Z'),
      start: '2026-06-01T10:00:00.000Z',
    });
    h.at('2026-06-01T11:00:00.000Z', (s) => {
      s.revoked = { revokedAt: '2026-06-01T11:00:00.000Z' };
    });
    await h.run();
    expect(h.calls).toEqual([
      'egress.block:sa_revoked',
      'audit:egress.blocked',
      'sessions.cancel',
      'run.expire:sa_revoked',
      'audit:sa.expired',
    ]);
    expect(h.lifecycle.state).toBe('expired');
    expect(h.clock.ms).toBe(new Date('2026-06-01T11:00:00.000Z').getTime());
    expect(h.audits[1]?.details).toMatchObject({ reason: 'sa_revoked' });
  });

  it('takes precedence over a finished signal only if revoked first; a revoked SA never reopens', async () => {
    const h = makeHarness({
      bounds: nightly('2026-06-30T00:00:00.000Z'),
      start: '2026-06-01T23:00:00.000Z',
    });
    h.at('2026-06-02T00:00:00.000Z', (s) => {
      s.revoked = { revokedAt: '2026-06-02T00:00:00.000Z' };
    });
    await h.run();
    expect(h.calls).not.toContain('sessions.resume');
    expect(h.lifecycle.state).toBe('expired');
  });
});

describe('test windows', () => {
  it('window close pauses traffic; the next window reopens execution', async () => {
    // 2026-06-01 22:00 BST = 21:00Z, open until 01:00Z; next 2026-06-02T21:00Z.
    const h = makeHarness({
      bounds: nightly('2026-06-30T00:00:00.000Z'),
      start: '2026-06-01T21:30:00.000Z',
    });
    h.at('2026-06-02T22:00:00.000Z', (s) => {
      s.finished = true;
    });
    await h.run();

    expect(h.calls).toEqual([
      'sessions.pause',
      'run.windowClosed:false',
      'audit:window.closed',
      'run.windowReopened',
      'sessions.resume',
      'audit:window.reopened',
    ]);
    expect(h.audits[0]?.details).toMatchObject({
      terminal: false,
      nextOpenAt: '2026-06-02T21:00:00.000Z',
    });
    expect(h.metrics.transitions).toEqual(['closed', 'reopened']);
    expect(h.lifecycle.state).toBe('executing');
  });

  it('pauses exactly at the close instant', async () => {
    const h = makeHarness({
      bounds: nightly('2026-06-30T00:00:00.000Z'),
      start: '2026-06-01T21:30:00.000Z',
    });
    h.at('2026-06-02T12:00:00.000Z', (s) => {
      s.finished = true;
    });
    let pausedAtMs = 0;
    const push = h.audits.push.bind(h.audits);
    h.audits.push = (...items): number => {
      for (const item of items) if (item.event === 'window.closed') pausedAtMs = h.clock.ms;
      return push(...items);
    };
    await h.run();
    expect(new Date(pausedAtMs).toISOString()).toBe('2026-06-02T01:00:00.000Z');
    expect(h.lifecycle.state).toBe('paused:window_closed');
  });

  it('with no further window before expiry the close is terminal: egress blocked, sessions cancelled, run stopped', async () => {
    const h = makeHarness({
      bounds: nightly('2026-06-02T08:00:00.000Z'),
      start: '2026-06-01T21:30:00.000Z',
    });
    await h.run();
    expect(h.calls).toEqual([
      'egress.block:window_closed',
      'audit:egress.blocked',
      'sessions.cancel',
      'run.windowClosed:true',
      'audit:window.closed',
    ]);
    expect(h.lifecycle.state).toBe('failed');
    expect(h.status.current).toMatchObject({ phase: 'stopped', stoppedFor: 'window_closed' });
    expect(h.metrics.transitions).toEqual(['closed_terminal']);
  });

  it('expiry while paused between windows blocks egress and expires', async () => {
    const h = makeHarness({
      bounds: nightly('2026-06-02T10:00:00.000Z'),
      start: '2026-06-01T21:30:00.000Z',
    });
    // Without the edit the close at 01:00Z would be terminal (no window before expiry); extending keeps it a pause.
    h.at('2026-06-01T23:00:00.000Z', (s) => {
      s.bounds = nightly('2026-06-04T00:00:00.000Z');
    });
    h.at('2026-06-03T00:00:00.000Z', (s) => {
      s.bounds = nightly('2026-06-03T01:00:00.000Z');
    });
    await h.run();
    expect(h.calls).toContain('sessions.pause');
    expect(h.calls).toContain('egress.block:sa_expired');
    expect(h.lifecycle.state).toBe('expired');
  });

  it('a window edit that closes the current window pauses; one that reopens resumes', async () => {
    const h = makeHarness({
      bounds: nightly('2026-06-30T00:00:00.000Z'),
      start: '2026-06-01T21:30:00.000Z',
    });
    const closedNow: SaTimeBounds = {
      ...nightly('2026-06-30T00:00:00.000Z'),
      testWindows: [{ cron: '0 6 * * *', timezone: 'UTC', durationMs: HOUR }],
    };
    h.at('2026-06-01T22:00:00.000Z', (s) => {
      s.bounds = closedNow;
    });
    h.at('2026-06-01T23:00:00.000Z', (s) => {
      s.bounds = nightly('2026-06-30T00:00:00.000Z');
    });
    h.at('2026-06-01T23:30:00.000Z', (s) => {
      s.finished = true;
    });
    await h.run();
    expect(h.calls).toEqual([
      'sessions.pause',
      'run.windowClosed:false',
      'audit:window.closed',
      'run.windowReopened',
      'sessions.resume',
      'audit:window.reopened',
    ]);
  });

  it('unparseable windows are treated as closed and never open the run', async () => {
    const bounds: SaTimeBounds = {
      ...nightly('2026-06-02T00:00:00.000Z'),
      testWindows: [{ cron: 'garbage', timezone: 'UTC', durationMs: HOUR }],
    };
    const h = makeHarness({ bounds, start: '2026-06-01T10:00:00.000Z' });
    await h.run();
    expect(h.calls).not.toContain('sessions.resume');
    expect(h.calls).not.toContain('run.windowReopened');
    expect(h.lifecycle.state).toBe('expired');
  });

  it('DST: a London window reopens at the correct UTC instant after spring forward', async () => {
    // Close at 2026-03-28T02:00Z; next open 2026-03-28T22:00Z (GMT); then the night of the 29th is BST.
    const h = makeHarness({
      bounds: nightly('2026-04-10T00:00:00.000Z'),
      start: '2026-03-28T01:00:00.000Z',
    });
    const reopenedAt: number[] = [];
    const orig = h.at.bind(h);
    orig('2026-03-30T00:00:00.000Z', (s) => {
      s.finished = true;
    });
    // Observe the virtual clock when each reopen audit is emitted.
    const emit = h.audits.push.bind(h.audits);
    h.audits.push = (...items): number => {
      for (const item of items) if (item.event === 'window.reopened') reopenedAt.push(h.clock.ms);
      return emit(...items);
    };
    await h.run();
    expect(reopenedAt.map((ms) => new Date(ms).toISOString())).toEqual([
      '2026-03-28T22:00:00.000Z',
      '2026-03-29T21:00:00.000Z',
    ]);
  });
});
