import { Settings } from 'luxon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixedClock, nowIso } from './clock.js';
import { formatDuration, parseDuration } from './duration.js';
import { fromIso, normalizeIso, toIso } from './iso.js';
import { isWithinWindow } from './window.js';
import { toZoned, zonedToUtc } from './zone.js';

/** Everything this package computes for a fixed set of inputs, as one comparable value. */
function snapshot(): unknown {
  const instants = [
    '2026-03-08T06:59:59.999Z',
    '2026-03-08T07:00:00.000Z',
    '2026-11-01T05:30:00.000Z',
    '2026-11-01T06:30:00.000Z',
    '2026-03-29T01:00:00.000Z',
    '2026-01-16T23:30:00.000Z',
  ];
  return {
    iso: instants.map((s) => toIso(fromIso(s))),
    normalised: normalizeIso('2026-03-08T02:30:00-05:00'),
    zoned: instants.map((s) => toZoned(fromIso(s), 'America/New_York')),
    windows: instants.map((s) => [
      isWithinWindow(fromIso(s), { tz: 'America/New_York', start: '01:30', end: '02:30' }),
      isWithinWindow(fromIso(s), {
        tz: 'Europe/London',
        start: '22:00',
        end: '06:00',
        days: [5, 6],
      }),
      isWithinWindow(fromIso(s), { tz: 'Asia/Tokyo', start: '08:00', end: '09:00', days: [6] }),
    ]),
    resolved: toIso(
      zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'),
    ),
    clock: nowIso(new FixedClock('2026-03-08T07:00:00.000Z').advance('1d')),
    duration: [parseDuration('1d'), formatDuration(86_400_000)],
  };
}

describe('independence from the host time zone', () => {
  const originalTz = process.env.TZ;
  const originalDefaultZone = Settings.defaultZone;
  let reference: unknown;

  beforeEach(() => {
    process.env.TZ = 'UTC';
    Settings.defaultZone = 'system';
    reference = snapshot();
  });

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    Settings.defaultZone = originalDefaultZone;
  });

  it.each([
    'America/Los_Angeles',
    'Asia/Kolkata',
    'Pacific/Kiritimati',
    'Europe/London',
    'Australia/Lord_Howe',
  ])('gives identical results when the host TZ is %s', (tz) => {
    process.env.TZ = tz;
    // Prove the host zone really changed for this process, so the comparison means something.
    // (Midsummer, so London is on BST and differs from UTC too.)
    expect(new Date(Date.UTC(2026, 6, 1, 12)).getHours()).not.toBe(12);
    expect(snapshot()).toEqual(reference);
  });

  it("ignores Luxon's global default zone", () => {
    Settings.defaultZone = 'Asia/Tokyo';
    expect(snapshot()).toEqual(reference);
  });
});
