import { describe, expect, it, vi } from 'vitest';

import {
  type Clock,
  Deadline,
  FixedClock,
  nowIso,
  nowUtc,
  SystemClock,
  systemClock,
  toInstantMs,
} from './clock.js';
import { TimeValidationError, type TimeValidationReason } from './errors.js';
import { fromIso, toIso } from './iso.js';

function reasonOf(fn: () => unknown): TimeValidationReason {
  try {
    fn();
  } catch (error) {
    if (error instanceof TimeValidationError) return error.reason;
    throw error;
  }
  throw new Error('expected a TimeValidationError');
}

const START = '2026-03-08T06:00:00.000Z';

describe('SystemClock', () => {
  it('reads Date.now() for wall time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(fromIso(START));
      expect(systemClock.nowMs()).toBe(fromIso(START).getTime());
      expect(toIso(systemClock.now())).toBe(START);
      expect(nowIso()).toBe(START);
      expect(toIso(nowUtc())).toBe(START);
    } finally {
      vi.useRealTimers();
    }
  });

  it('has a non-decreasing monotonic reading', () => {
    const clock = new SystemClock();
    const a = clock.monotonicMs();
    const b = clock.monotonicMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('returns a fresh Date each call and the shared instance is frozen', () => {
    expect(systemClock.now()).not.toBe(systemClock.now());
    expect(Object.isFrozen(systemClock)).toBe(true);
  });
});

describe('FixedClock', () => {
  it('accepts a Date, epoch milliseconds or a canonical ISO string', () => {
    expect(new FixedClock(START).nowMs()).toBe(Date.UTC(2026, 2, 8, 6));
    expect(new FixedClock(Date.UTC(2026, 2, 8, 6)).nowMs()).toBe(Date.UTC(2026, 2, 8, 6));
    expect(new FixedClock(new Date(Date.UTC(2026, 2, 8, 6))).nowMs()).toBe(Date.UTC(2026, 2, 8, 6));
  });

  it('rejects non-canonical or invalid start instants', () => {
    expect(reasonOf(() => new FixedClock('2026-03-08T06:00:00'))).toBe('missing_offset');
    expect(reasonOf(() => new FixedClock(Number.NaN))).toBe('invalid_date');
  });

  it('does not move on its own', async () => {
    const clock = new FixedClock(START);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(toIso(clock.now())).toBe(START);
    expect(clock.monotonicMs()).toBe(0);
  });

  it('advance moves wall and monotonic time together', () => {
    const clock = new FixedClock(START);
    clock.advance('5m').advance(1_500);
    expect(nowIso(clock)).toBe('2026-03-08T06:05:01.500Z');
    expect(clock.monotonicMs()).toBe(301_500);
  });

  it('advance rejects negative and NaN durations', () => {
    const clock = new FixedClock(START);
    expect(reasonOf(() => clock.advance('-1s'))).toBe('negative_duration');
    expect(reasonOf(() => clock.advance(-1))).toBe('negative_duration');
    expect(reasonOf(() => clock.advance(Number.NaN))).toBe('invalid_duration');
    expect(nowIso(clock)).toBe(START);
  });

  it('set steps the wall clock (even backwards) without touching monotonic time', () => {
    const clock = new FixedClock(START).advance('10s');
    clock.set('2026-03-08T05:00:00.000Z');
    expect(nowIso(clock)).toBe('2026-03-08T05:00:00.000Z');
    expect(clock.monotonicMs()).toBe(10_000);
  });

  it('hands out copies, so callers cannot move the clock by mutating a Date', () => {
    const clock = new FixedClock(START);
    clock.now().setUTCFullYear(1999);
    expect(nowIso(clock)).toBe(START);
  });
});

/** A component that takes its clock through the constructor, as every time-dependent service must. */
class GateTimer {
  readonly #deadline: Deadline;
  constructor(timeout: string, clock: Clock) {
    this.#deadline = Deadline.after(timeout, clock);
  }
  decision(): 'pending' | 'denied' {
    return this.#deadline.isExpired() ? 'denied' : 'pending';
  }
}

describe('Deadline', () => {
  it('is driven entirely by the injected clock (constructor injection)', () => {
    const clock = new FixedClock(START);
    const gate = new GateTimer('15m', clock);
    expect(gate.decision()).toBe('pending');
    clock.advance('14m');
    expect(gate.decision()).toBe('pending');
    clock.advance('1m');
    expect(gate.decision()).toBe('denied');
  });

  it('expires at exactly expiresAt (the boundary denies)', () => {
    const clock = new FixedClock(START);
    const deadline = new Deadline('2026-03-08T06:00:01.000Z', clock);
    expect(deadline.isExpired()).toBe(false);
    expect(deadline.remainingMs()).toBe(1_000);
    clock.advance(999);
    expect(deadline.isExpired()).toBe(false);
    expect(deadline.remainingMs()).toBe(1);
    clock.advance(1);
    expect(deadline.isExpired()).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
    clock.advance('1h');
    expect(deadline.remainingMs()).toBe(0);
  });

  it('an envelope that expires mid-run is detected on the next check', () => {
    const clock = new FixedClock(START);
    const envelope = new Deadline('2026-03-08T06:30:00.000Z', clock);
    const checks: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      checks.push(envelope.isExpired());
      clock.advance('10m');
    }
    expect(checks).toEqual([false, false, false, true]);
  });

  it('follows wall-clock steps (a clock set past expiry expires the deadline)', () => {
    const clock = new FixedClock(START);
    const deadline = Deadline.after('1h', clock);
    expect(toIso(deadline.expiresAt)).toBe('2026-03-08T07:00:00.000Z');
    clock.set('2026-03-08T08:00:00.000Z');
    expect(deadline.isExpired()).toBe(true);
  });

  it('fails closed when a custom clock returns garbage', () => {
    const broken: Clock = {
      now: () => new Date(Number.NaN),
      nowMs: () => Number.NaN,
      monotonicMs: () => 0,
    };
    const deadline = new Deadline('2999-01-01T00:00:00.000Z', broken);
    expect(deadline.isExpired()).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
  });

  it('reads the clock once per call, so remainingMs is never negative or NaN', () => {
    const expiresAtMs = Date.UTC(2026, 2, 8, 7);
    // Before expiry on the first read, past it (or broken) on any later read.
    const readings = (later: number) => {
      let calls = 0;
      const clock: Clock = {
        now: () => new Date(0),
        nowMs: () => (calls++ === 0 ? expiresAtMs - 1 : later),
        monotonicMs: () => 0,
      };
      return clock;
    };
    expect(new Deadline(expiresAtMs, readings(expiresAtMs + 1_000)).remainingMs()).toBe(1);
    expect(new Deadline(expiresAtMs, readings(Number.NaN)).remainingMs()).toBe(1);
    expect(new Deadline(expiresAtMs, readings(expiresAtMs + 1_000)).isExpired()).toBe(false);
  });

  it('defensively copies expiresAt', () => {
    const deadline = new Deadline(START, new FixedClock(START));
    deadline.expiresAt.setUTCFullYear(2999);
    expect(toIso(deadline.expiresAt)).toBe(START);
  });

  it('rejects invalid expiry instants and durations', () => {
    expect(reasonOf(() => new Deadline('tomorrow'))).toBe('malformed');
    expect(reasonOf(() => Deadline.after('-5m', new FixedClock(START)))).toBe('negative_duration');
  });
});

describe('toInstantMs', () => {
  it('accepts the three instant forms and rejects others', () => {
    expect(toInstantMs(START)).toBe(Date.UTC(2026, 2, 8, 6));
    expect(toInstantMs(new Date(5))).toBe(5);
    expect(toInstantMs(5)).toBe(5);
    expect(reasonOf(() => toInstantMs({} as unknown as number))).toBe('invalid_type');
  });
});
