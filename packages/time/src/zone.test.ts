import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { VERSION } from 'luxon';
import { describe, expect, it } from 'vitest';

import { TimeValidationError, type TimeValidationReason } from './errors.js';
import { fromIso, MAX_ISO_MS, MIN_ISO_MS, toIso } from './iso.js';
import {
  assertTimeZone,
  isIsoWeekday,
  isValidTimeZone,
  PINNED_LUXON_VERSION,
  timeZoneRuntime,
  toZoned,
  zonedToUtc,
} from './zone.js';

function reasonOf(fn: () => unknown): TimeValidationReason {
  try {
    fn();
  } catch (error) {
    if (error instanceof TimeValidationError) return error.reason;
    throw error;
  }
  throw new Error('expected a TimeValidationError');
}

const ZONES = [
  'America/New_York',
  'Europe/London',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'America/Havana',
  'Asia/Kolkata',
  'Pacific/Chatham',
  'Pacific/Apia',
  'UTC',
] as const;

const iso = (date: Date): string => toIso(date);

describe('version pinning', () => {
  it('runs on the exactly pinned Luxon version', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies.luxon).toBe(PINNED_LUXON_VERSION);
    expect(VERSION).toBe(PINNED_LUXON_VERSION);
    expect(timeZoneRuntime().libraryVersion).toBe(PINNED_LUXON_VERSION);
  });

  it("reports the runtime tz database version (from Node's ICU)", () => {
    const runtime = timeZoneRuntime();
    expect(runtime.library).toBe('luxon');
    expect(runtime.tzdataVersion).toMatch(/^\d{4}[a-z]$/);
    expect(runtime.tzdataVersion).toBe(process.versions.tz);
  });

  it('has full ICU time-zone data (a small-icu build would get these offsets wrong)', () => {
    expect(toZoned(fromIso('2026-07-01T12:00:00.000Z'), 'America/New_York').offsetMinutes).toBe(
      -240,
    );
    expect(toZoned(fromIso('2026-07-01T12:00:00.000Z'), 'Pacific/Chatham').offsetMinutes).toBe(765);
  });
});

describe('isIsoWeekday', () => {
  it('accepts 1 (Monday) to 7 (Sunday) only', () => {
    expect([1, 2, 3, 4, 5, 6, 7].every((day) => isIsoWeekday(day))).toBe(true);
    expect([0, 8, 1.5, -1, Number.NaN, '1', null].some((day) => isIsoWeekday(day))).toBe(false);
  });
});

describe('isValidTimeZone / assertTimeZone', () => {
  it.each([
    'Europe/London',
    'America/New_York',
    'America/Argentina/Buenos_Aires',
    'UTC',
    'Etc/UTC',
    'Etc/GMT+3',
    'EST5EDT',
    'US/Eastern',
    'europe/london',
  ])('accepts IANA name %s', (tz) => {
    expect(isValidTimeZone(tz)).toBe(true);
    expect(assertTimeZone(tz)).toBe(tz);
  });

  it.each([
    ['host alias local', 'local'],
    ['host alias system', 'system'],
    ['host alias default', 'default'],
    ['host alias Local', 'Local'],
    ['ECMA-402 offset zone', '+03:00'],
    ['negative offset zone', '-05:00'],
    ['Luxon fixed-offset specifier', 'UTC+3'],
    ['unknown zone', 'Fantasia/Castle'],
    ['path traversal', 'Europe/../London'],
    ['leading space', ' Europe/London'],
    ['trailing newline', 'Europe/London\n'],
    ['empty', ''],
    ['oversized', 'A'.repeat(65)],
  ])('rejects %s', (_label, tz) => {
    expect(isValidTimeZone(tz)).toBe(false);
    expect(reasonOf(() => assertTimeZone(tz))).toBe('invalid_time_zone');
    expect(reasonOf(() => toZoned(0, tz))).toBe('invalid_time_zone');
  });

  it('rejects non-strings', () => {
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(0)).toBe(false);
    expect(reasonOf(() => assertTimeZone(null))).toBe('invalid_time_zone');
  });

  it('evaluates aliases and case variants exactly like the canonical name', () => {
    const at = fromIso('2026-11-01T05:30:00.000Z');
    expect(toZoned(at, 'us/eastern')).toEqual(toZoned(at, 'America/New_York'));
  });
});

describe('toZoned', () => {
  it('reads the wall clock either side of the New York spring-forward transition', () => {
    expect(toZoned(fromIso('2026-03-08T06:59:59.999Z'), 'America/New_York')).toEqual({
      year: 2026,
      month: 3,
      day: 8,
      hour: 1,
      minute: 59,
      second: 59,
      millisecond: 999,
      weekday: 7,
      offsetMinutes: -300,
    });
    expect(toZoned(fromIso('2026-03-08T07:00:00.000Z'), 'America/New_York')).toMatchObject({
      hour: 3,
      minute: 0,
      offsetMinutes: -240,
    });
  });

  it('reads half-hour and 45-minute offsets', () => {
    expect(toZoned(fromIso('2026-01-15T03:30:00.000Z'), 'Asia/Kolkata')).toMatchObject({
      hour: 9,
      minute: 0,
      offsetMinutes: 330,
    });
    expect(toZoned(fromIso('2026-01-15T00:00:00.000Z'), 'Pacific/Chatham')).toMatchObject({
      hour: 13,
      minute: 45,
      offsetMinutes: 825,
    });
  });

  it('jumps over the day Samoa skipped (Pacific/Apia, 2011-12-30)', () => {
    expect(toZoned(fromIso('2011-12-30T09:59:59.999Z'), 'Pacific/Apia')).toMatchObject({
      day: 29,
      hour: 23,
      weekday: 4,
    });
    expect(toZoned(fromIso('2011-12-30T10:00:00.000Z'), 'Pacific/Apia')).toMatchObject({
      day: 31,
      hour: 0,
      weekday: 6,
    });
  });

  it('rejects invalid instants', () => {
    expect(reasonOf(() => toZoned(new Date(Number.NaN), 'UTC'))).toBe('invalid_date');
  });
});

describe('zonedToUtc', () => {
  const ny = 'America/New_York';

  it('resolves an unambiguous wall time', () => {
    expect(iso(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, ny))).toBe(
      '2026-07-01T13:00:00.000Z',
    );
    expect(
      iso(
        zonedToUtc(
          { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 5, millisecond: 7 },
          'Asia/Kolkata',
        ),
      ),
    ).toBe('2026-07-01T03:30:05.007Z');
  });

  it('DST gap (New York 2026-03-08 02:30 does not exist): every policy', () => {
    const local = { year: 2026, month: 3, day: 8, hour: 2, minute: 30 };
    expect(iso(zonedToUtc(local, ny))).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
    expect(iso(zonedToUtc(local, ny, { disambiguation: 'compatible' }))).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    expect(iso(zonedToUtc(local, ny, { disambiguation: 'later' }))).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    expect(iso(zonedToUtc(local, ny, { disambiguation: 'earlier' }))).toBe(
      '2026-03-08T06:30:00.000Z',
    ); // 01:30 EST
    expect(reasonOf(() => zonedToUtc(local, ny, { disambiguation: 'reject' }))).toBe(
      'nonexistent_local_time',
    );
  });

  it('DST overlap (New York 2026-11-01 01:30 occurs twice): every policy', () => {
    const local = { year: 2026, month: 11, day: 1, hour: 1, minute: 30 };
    expect(iso(zonedToUtc(local, ny))).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT
    expect(iso(zonedToUtc(local, ny, { disambiguation: 'earlier' }))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(iso(zonedToUtc(local, ny, { disambiguation: 'later' }))).toBe(
      '2026-11-01T06:30:00.000Z',
    ); // 01:30 EST
    expect(reasonOf(() => zonedToUtc(local, ny, { disambiguation: 'reject' }))).toBe(
      'ambiguous_local_time',
    );
  });

  it('the transition instants themselves are unambiguous', () => {
    // 03:00 EDT exists once (it is the first instant after the gap); 02:00 EST exists once too.
    expect(
      iso(
        zonedToUtc({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, ny, {
          disambiguation: 'reject',
        }),
      ),
    ).toBe('2026-03-08T07:00:00.000Z');
    expect(
      iso(
        zonedToUtc({ year: 2026, month: 11, day: 1, hour: 2, minute: 0 }, ny, {
          disambiguation: 'reject',
        }),
      ),
    ).toBe('2026-11-01T07:00:00.000Z');
  });

  it('Europe/London gap and overlap', () => {
    const tz = 'Europe/London';
    expect(iso(zonedToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, tz))).toBe(
      '2026-03-29T01:30:00.000Z',
    ); // 02:30 BST
    expect(
      iso(
        zonedToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, tz, {
          disambiguation: 'earlier',
        }),
      ),
    ).toBe('2026-03-29T00:30:00.000Z');
    expect(iso(zonedToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, tz))).toBe(
      '2026-10-25T00:30:00.000Z',
    ); // BST
    expect(
      iso(
        zonedToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, tz, {
          disambiguation: 'later',
        }),
      ),
    ).toBe('2026-10-25T01:30:00.000Z');
  });

  it('southern hemisphere (Australia/Sydney): overlap in April, gap in October', () => {
    const tz = 'Australia/Sydney';
    expect(
      reasonOf(() =>
        zonedToUtc({ year: 2026, month: 4, day: 5, hour: 2, minute: 30 }, tz, {
          disambiguation: 'reject',
        }),
      ),
    ).toBe('ambiguous_local_time');
    expect(
      reasonOf(() =>
        zonedToUtc({ year: 2026, month: 10, day: 4, hour: 2, minute: 30 }, tz, {
          disambiguation: 'reject',
        }),
      ),
    ).toBe('nonexistent_local_time');
    expect(iso(zonedToUtc({ year: 2026, month: 10, day: 4, hour: 2, minute: 30 }, tz))).toBe(
      '2026-10-03T16:30:00.000Z',
    ); // 03:30 AEDT
  });

  it('30-minute DST shift (Australia/Lord_Howe)', () => {
    const tz = 'Australia/Lord_Howe';
    const gap = { year: 2026, month: 10, day: 4, hour: 2, minute: 15 };
    expect(iso(zonedToUtc(gap, tz))).toBe('2026-10-03T15:45:00.000Z'); // 02:45 +11:00
    expect(iso(zonedToUtc(gap, tz, { disambiguation: 'earlier' }))).toBe(
      '2026-10-03T15:15:00.000Z',
    ); // 01:45 +10:30
    const overlap = { year: 2026, month: 4, day: 5, hour: 1, minute: 45 };
    expect(iso(zonedToUtc(overlap, tz, { disambiguation: 'earlier' }))).toBe(
      '2026-04-04T14:45:00.000Z',
    ); // +11:00
    expect(iso(zonedToUtc(overlap, tz, { disambiguation: 'later' }))).toBe(
      '2026-04-04T15:15:00.000Z',
    ); // +10:30
  });

  it('midnight transitions (America/Havana): local midnight may not exist, or occur twice', () => {
    const tz = 'America/Havana';
    expect(
      reasonOf(() =>
        zonedToUtc({ year: 2026, month: 3, day: 8, hour: 0, minute: 0 }, tz, {
          disambiguation: 'reject',
        }),
      ),
    ).toBe('nonexistent_local_time');
    expect(iso(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 0, minute: 0 }, tz))).toBe(
      '2026-03-08T05:00:00.000Z',
    ); // 01:00 CDT
    expect(
      reasonOf(() =>
        zonedToUtc({ year: 2026, month: 11, day: 1, hour: 0, minute: 30 }, tz, {
          disambiguation: 'reject',
        }),
      ),
    ).toBe('ambiguous_local_time');
  });

  it('a skipped calendar day (Pacific/Apia 2011-12-30) has no instants', () => {
    const local = { year: 2011, month: 12, day: 30, hour: 12, minute: 0 };
    expect(reasonOf(() => zonedToUtc(local, 'Pacific/Apia', { disambiguation: 'reject' }))).toBe(
      'nonexistent_local_time',
    );
    // Shifted forward by the 24 h gap, it lands on Saturday 2011-12-31 12:00.
    expect(toZoned(zonedToUtc(local, 'Pacific/Apia'), 'Pacific/Apia')).toMatchObject({
      day: 31,
      hour: 12,
    });
  });

  it('validates the wall-clock fields and the zone', () => {
    expect(
      reasonOf(() => zonedToUtc({ year: 2026, month: 2, day: 30, hour: 0, minute: 0 }, 'UTC')),
    ).toBe('out_of_range');
    expect(
      reasonOf(() => zonedToUtc({ year: 2026, month: 1, day: 1, hour: 24, minute: 0 }, 'UTC')),
    ).toBe('out_of_range');
    expect(
      reasonOf(() =>
        zonedToUtc({ year: 2016, month: 12, day: 31, hour: 23, minute: 59, second: 60 }, 'UTC'),
      ),
    ).toBe('leap_second');
    expect(
      reasonOf(() => zonedToUtc({ year: 2026, month: 1, day: 1, hour: 0, minute: 0 }, 'local')),
    ).toBe('invalid_time_zone');
    expect(
      reasonOf(() => zonedToUtc({ year: 0, month: 1, day: 1, hour: 0, minute: 0 }, 'Asia/Kolkata')),
    ).toBe('year_out_of_range');
  });

  it('inverts toZoned for every instant: earlier or later recovers it (property, several zones)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2040, 0, 1) }),
        fc.constantFrom(...ZONES),
        (ms, tz) => {
          const parts = toZoned(ms, tz);
          const earlier = zonedToUtc(parts, tz, { disambiguation: 'earlier' }).getTime();
          const later = zonedToUtc(parts, tz, { disambiguation: 'later' }).getTime();
          expect([earlier, later]).toContain(ms);
          expect(earlier).toBeLessThanOrEqual(later);
        },
      ),
      { numRuns: 1000 },
    );
  }, 60_000);

  it('the resolved instant reads back as the requested wall time unless it was in a gap (property)', () => {
    fc.assert(
      fc.property(
        fc.record({
          year: fc.integer({ min: 1990, max: 2040 }),
          month: fc.integer({ min: 1, max: 12 }),
          day: fc.integer({ min: 1, max: 28 }),
          hour: fc.integer({ min: 0, max: 23 }),
          minute: fc.integer({ min: 0, max: 59 }),
        }),
        fc.constantFrom(...ZONES),
        (local, tz) => {
          let inGap = false;
          try {
            zonedToUtc(local, tz, { disambiguation: 'reject' });
          } catch (error) {
            inGap =
              error instanceof TimeValidationError && error.reason === 'nonexistent_local_time';
          }
          const parts = toZoned(zonedToUtc(local, tz), tz);
          const readBack = {
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hour: parts.hour,
            minute: parts.minute,
          };
          // Inside a gap the instant is shifted, so it reads differently; elsewhere it reads back.
          expect(JSON.stringify(readBack) === JSON.stringify(local)).toBe(!inGap);
        },
      ),
      { numRuns: 1000 },
    );
  }, 60_000);

  it('covers the edges of the supported range in UTC', () => {
    expect(zonedToUtc({ year: 0, month: 1, day: 1, hour: 0, minute: 0 }, 'UTC').getTime()).toBe(
      MIN_ISO_MS,
    );
    expect(
      zonedToUtc(
        { year: 9999, month: 12, day: 31, hour: 23, minute: 59, second: 59, millisecond: 999 },
        'UTC',
      ).getTime(),
    ).toBe(MAX_ISO_MS);
  });
});
