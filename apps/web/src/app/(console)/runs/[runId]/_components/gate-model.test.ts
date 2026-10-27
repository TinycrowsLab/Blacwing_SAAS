import { describe, expect, it } from 'vitest';

import {
  canActAtGate,
  foldGateEvents,
  formatRemaining,
  gate2Countdown,
  gateForRun,
  isOwnGate1Request,
  visibleGates,
} from './gate-model';

import type { RunEvent } from '@blackwing/contracts';

const ev = (type: string, payload: Record<string, unknown>): RunEvent => ({
  type,
  ts: '2026-10-20T10:00:00.000Z',
  seq: 1,
  payload,
});

describe('gateForRun', () => {
  it('maps states to gates and everything else to null', () => {
    expect(gateForRun({ state: 'awaiting_gate1', pauseReason: null })).toBe(1);
    expect(gateForRun({ state: 'awaiting_gate3', pauseReason: null })).toBe(3);
    expect(gateForRun({ state: 'paused', pauseReason: 'gate2_pending' })).toBe(2);
    expect(gateForRun({ state: 'paused', pauseReason: 'kill_pending' as never })).toBeNull();
    expect(gateForRun({ state: 'executing', pauseReason: null })).toBeNull();
    expect(gateForRun({ state: 'released', pauseReason: null })).toBeNull();
  });
});

describe('visibleGates', () => {
  const run = { state: 'awaiting_gate1', pauseReason: null } as const;
  it('shows the state gate with known data', () => {
    expect(visibleGates(run, [{ gate: 1 }], [])).toEqual([{ gate: 1 }]);
  });
  it('hides on gate.decided and re-shows on a later gate.pending', () => {
    expect(visibleGates(run, [], [ev('gate.decided', { gate: 1 })])).toEqual([]);
    expect(
      visibleGates(run, [], [ev('gate.decided', { gate: 1 }), ev('gate.pending', { gate: 1 })]),
    ).toEqual([{ gate: 1, subject: null, timeoutAt: null }]);
  });
  it('appears on gate.pending even before the run state catches up, stacked 1,2,3', () => {
    const shown = visibleGates(
      { state: 'awaiting_gate3', pauseReason: null },
      [],
      [
        ev('gate.pending', {
          gate: 2,
          subject: 'port-scan',
          timeoutAt: '2026-10-20T10:05:00.000Z',
        }),
      ],
    );
    expect(shown.map((g) => g.gate)).toEqual([2, 3]);
    expect(shown[0]).toMatchObject({ subject: 'port-scan' });
  });
  it('ignores malformed and unrelated events', () => {
    const folded = foldGateEvents([
      ev('gate.pending', { gate: 7 }),
      ev('gate.pending', { gate: 2, timeoutAt: 'tomorrow' }),
      ev('tool.call', { gate: 1 }),
    ]);
    expect(folded.size).toBe(0);
  });
});

describe('gate2Countdown', () => {
  const t = '2026-10-20T10:00:10.000Z';
  const base = Date.parse('2026-10-20T10:00:00.000Z');
  it('counts down on the server clock using the offset', () => {
    expect(gate2Countdown(t, base, 0, false)).toEqual({ kind: 'running', remainingMs: 10_000 });
    // client clock 4s behind the server: only 6s remain.
    expect(gate2Countdown(t, base - 4000, 4000 + 0, false)).toEqual({
      kind: 'running',
      remainingMs: 10_000,
    });
    expect(gate2Countdown(t, base, 4000, false)).toEqual({ kind: 'running', remainingMs: 6000 });
  });
  it('distinguishes timing out live from already expired, never approval', () => {
    expect(gate2Countdown(t, base + 10_000, 0, true)).toEqual({ kind: 'timed_out' });
    expect(gate2Countdown(t, base + 99_000, 0, false)).toEqual({ kind: 'expired' });
  });
  it('has no countdown without a usable timeout', () => {
    expect(gate2Countdown(null, base, 0, false)).toEqual({ kind: 'none' });
    expect(gate2Countdown('garbage', base, 0, false)).toEqual({ kind: 'none' });
  });
  it('is unaffected by DST: it is pure epoch arithmetic', () => {
    expect(
      gate2Countdown('2026-11-01T06:30:00.000Z', Date.parse('2026-11-01T05:30:00.000Z'), 0, false),
    ).toEqual({ kind: 'running', remainingMs: 3_600_000 });
  });
});

describe('formatRemaining', () => {
  it('formats and rounds up', () => {
    expect(formatRemaining(247_000)).toBe('4:07');
    expect(formatRemaining(1)).toBe('0:01');
    expect(formatRemaining(3_909_000)).toBe('1:05:09');
    expect(formatRemaining(-5)).toBe('0:00');
  });
});

describe('role and SoD gating', () => {
  it('lets only the owning roles act', () => {
    expect(canActAtGate(['asset_owner'], 1)).toBe(true);
    expect(canActAtGate(['asset_owner'], 2)).toBe(true);
    expect(canActAtGate(['asset_owner'], 3)).toBe(false);
    expect(canActAtGate(['appsec_engineer'], 3)).toBe(true);
    expect(canActAtGate(['appsec_engineer'], 1)).toBe(false);
    expect(canActAtGate(['developer', 'bogus'], 3)).toBe(false);
    expect(canActAtGate([], 1)).toBe(false);
  });
  it('treats the requester, or an unknown identity, as the same person', () => {
    expect(isOwnGate1Request('u1', 'u1')).toBe(true);
    expect(isOwnGate1Request('u1', 'u2')).toBe(false);
    expect(isOwnGate1Request(null, 'u2')).toBe(true);
    expect(isOwnGate1Request('u1', null)).toBe(true);
  });
});
