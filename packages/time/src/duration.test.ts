import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  addDuration,
  assertDurationMs,
  DURATION_UNITS,
  type DurationUnit,
  formatDuration,
  parseDuration,
  toDurationMs,
} from './duration.js';
import { TimeValidationError, type TimeValidationReason } from './errors.js';
import { fromIso, MAX_ISO_MS, toIso } from './iso.js';

function reasonOf(fn: () => unknown): TimeValidationReason {
  try {
    fn();
  } catch (error) {
    if (error instanceof TimeValidationError) return error.reason;
    throw error;
  }
  throw new Error('expected a TimeValidationError');
}

const UNITS = Object.keys(DURATION_UNITS) as DurationUnit[];

describe('parseDuration', () => {
  it('parses the acceptance examples', () => {
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it.each([
    ['250ms', 250],
    ['0ms', 0],
    ['0s', 0],
    ['1s', 1_000],
    ['90s', 90_000],
    ['1m', 60_000],
    ['1h', 3_600_000],
    ['1d', 86_400_000],
    ['7d', 604_800_000],
    ['05m', 300_000],
  ])('parses %s as %i ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it('treats a day as exactly 24 hours of elapsed time', () => {
    expect(parseDuration('1d')).toBe(parseDuration('24h'));
  });

  it.each(['-1s', '-0s', '-5m', '-1.5h', '-1'])('rejects negative %s', (text) => {
    expect(reasonOf(() => parseDuration(text))).toBe('negative_duration');
  });

  it.each(['5M', '5S', '5H', '5D', '5MS', '5w', '5y', '5us', '5min', '5sec'])(
    'rejects unknown or wrongly cased unit %s',
    (text) => {
      expect(reasonOf(() => parseDuration(text))).toBe('unknown_unit');
    },
  );

  it.each([
    ['NaN', 'NaN'],
    ['NaN with unit', 'NaNs'],
    ['Infinity', 'Infinitys'],
    ['no unit', '300'],
    ['empty', ''],
    ['unit only', 's'],
    ['fraction', '1.5h'],
    ['exponent', '1e3ms'],
    ['hex', '0x10s'],
    ['plus sign', '+5m'],
    ['inner space', '5 m'],
    ['leading space', ' 5m'],
    ['trailing space', '5m '],
    ['compound', '1h30m'],
    ['ISO-8601 duration', 'PT5M'],
    ['too long', `${'1'.repeat(40)}s`],
  ])('rejects %s as invalid', (_label, text) => {
    expect(reasonOf(() => parseDuration(text))).toBe('invalid_duration');
  });

  it('rejects non-strings, including NaN', () => {
    expect(reasonOf(() => parseDuration(Number.NaN as unknown as string))).toBe('invalid_type');
    expect(reasonOf(() => parseDuration(300 as unknown as string))).toBe('invalid_type');
    expect(reasonOf(() => parseDuration(null as unknown as string))).toBe('invalid_type');
  });

  it('rejects results beyond Number.MAX_SAFE_INTEGER milliseconds', () => {
    expect(parseDuration(`${Number.MAX_SAFE_INTEGER}ms`)).toBe(Number.MAX_SAFE_INTEGER);
    expect(reasonOf(() => parseDuration('9007199254740992ms'))).toBe('duration_overflow');
    expect(reasonOf(() => parseDuration('104249991375d'))).toBe('duration_overflow');
    expect(reasonOf(() => parseDuration('99999999999999999999s'))).toBe('duration_overflow');
  });

  it('parses n<unit> as n times the unit (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.constantFrom(...UNITS),
        (n, unit) => {
          expect(parseDuration(`${n}${unit}`)).toBe(n * DURATION_UNITS[unit]);
        },
      ),
    );
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [1, '1ms'],
    [1_500, '1500ms'],
    [30_000, '30s'],
    [90_000, '90s'],
    [300_000, '5m'],
    [5_400_000, '90m'],
    [7_200_000, '2h'],
    [86_400_000, '1d'],
    [90_000_000, '25h'],
  ])('formats %i ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it('round-trips through parseDuration (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (ms) => {
        expect(parseDuration(formatDuration(ms))).toBe(ms);
      }),
      { numRuns: 2000 },
    );
  });

  it('rejects negative, NaN, infinite and fractional values', () => {
    expect(reasonOf(() => formatDuration(-1))).toBe('negative_duration');
    expect(reasonOf(() => formatDuration(Number.NaN))).toBe('invalid_duration');
    expect(reasonOf(() => formatDuration(Number.POSITIVE_INFINITY))).toBe('invalid_duration');
    expect(reasonOf(() => formatDuration(1.5))).toBe('invalid_duration');
    expect(reasonOf(() => formatDuration(Number.MAX_SAFE_INTEGER + 1))).toBe('duration_overflow');
    expect(reasonOf(() => formatDuration('5m' as unknown as number))).toBe('invalid_type');
  });
});

describe('toDurationMs / assertDurationMs', () => {
  it('accepts a string or a millisecond count', () => {
    expect(toDurationMs('5m')).toBe(300_000);
    expect(toDurationMs(300_000)).toBe(300_000);
    expect(assertDurationMs(0)).toBe(0);
  });

  it('rejects negative and NaN counts', () => {
    expect(reasonOf(() => toDurationMs(-1))).toBe('negative_duration');
    expect(reasonOf(() => toDurationMs(Number.NaN))).toBe('invalid_duration');
    expect(reasonOf(() => toDurationMs('-1s'))).toBe('negative_duration');
  });
});

describe('addDuration', () => {
  it('adds elapsed time, so a 1d step across a DST change is 24 real hours', () => {
    // New York springs forward on 2026-03-08; the result is 24 h later in UTC, 25 h later on the wall.
    expect(toIso(addDuration(fromIso('2026-03-07T12:00:00.000Z'), '1d'))).toBe(
      '2026-03-08T12:00:00.000Z',
    );
    expect(toIso(addDuration(0, 1_500))).toBe('1970-01-01T00:00:01.500Z');
  });

  it('does not mutate its input', () => {
    const start = fromIso('2026-01-01T00:00:00.000Z');
    addDuration(start, '1h');
    expect(toIso(start)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects negative durations, invalid instants and results past year 9999', () => {
    expect(reasonOf(() => addDuration(0, '-1s'))).toBe('negative_duration');
    expect(reasonOf(() => addDuration(new Date(Number.NaN), '1s'))).toBe('invalid_date');
    expect(reasonOf(() => addDuration(MAX_ISO_MS, '1ms'))).toBe('year_out_of_range');
  });
});
