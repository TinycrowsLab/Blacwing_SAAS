// FixedClock itself is tested in @blackwing/time. These tests cover the testing-side wiring: the
// re-export, the default epoch, useFixedClock driving Vitest's faked Date, and the UTC time zone.

import { describe, expect, it } from 'vitest';

import * as time from '@blackwing/time';

import { DEFAULT_TEST_EPOCH, FixedClock } from './clock.js';
import { createFactories } from './factories.js';
import { useFixedClock } from './vitest/index.js';

describe('test clock', () => {
  it('is the @blackwing/time FixedClock', () => {
    expect(FixedClock).toBe(time.FixedClock);
  });

  it('factories default to a FixedClock at the default epoch', () => {
    const f = createFactories();
    expect(time.nowIso(f.clock)).toBe(DEFAULT_TEST_EPOCH);
    expect(f.makeTenant().createdAt).toBe(DEFAULT_TEST_EPOCH);
  });

  it('factories take their timestamps from the injected clock', () => {
    const clock = new FixedClock('2026-03-01T12:00:00.000Z');
    const f = createFactories({ clock });
    expect(f.makeRun().createdAt).toBe('2026-03-01T12:00:00.000Z');
    clock.advance('90s');
    expect(f.makeRun().createdAt).toBe('2026-03-01T12:01:30.000Z');
  });
});

describe('useFixedClock (Vitest wiring)', () => {
  const clock = useFixedClock('2026-06-01T08:00:00.000Z');

  it('freezes Date and Date.now at the start instant', () => {
    expect(new Date().toISOString()).toBe('2026-06-01T08:00:00.000Z');
    expect(Date.now()).toBe(clock.nowMs());
  });

  it('moves Date together with the clock (advance and set)', () => {
    clock.advance('1m');
    expect(new Date().toISOString()).toBe('2026-06-01T08:01:00.000Z');
    clock.set('2026-06-02T00:00:00.000Z');
    expect(Date.now()).toBe(Date.parse('2026-06-02T00:00:00.000Z'));
  });

  it('resets to the start instant before each test', () => {
    expect(time.nowIso(clock)).toBe('2026-06-01T08:00:00.000Z');
    expect(new Date().toISOString()).toBe('2026-06-01T08:00:00.000Z');
  });

  it('keeps real timers running (only Date is faked)', async () => {
    await expect(
      new Promise((resolve) =>
        setTimeout(() => {
          resolve('fired');
        }, 1),
      ),
    ).resolves.toBe('fired');
  });
});

describe('time zone', () => {
  it('runs tests in UTC regardless of the host time zone', () => {
    expect(process.env.TZ).toBe('UTC');
    expect(new Date(0).getTimezoneOffset()).toBe(0);
  });
});
