import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toProblemDetails, ValidationError } from '@blackwing/errors';

import { TimeValidationError, type TimeValidationReason } from './errors.js';
import {
  civilToUtcMs,
  fromIso,
  instantToMs,
  isIsoTimestamp,
  MAX_ISO_MS,
  MIN_ISO_MS,
  normalizeIso,
  toIso,
} from './iso.js';

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function reasonOf(fn: () => unknown): TimeValidationReason {
  try {
    fn();
  } catch (error) {
    if (error instanceof TimeValidationError) return error.reason;
    throw error;
  }
  throw new Error('expected a TimeValidationError');
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** Canonical strings built from fields, independent of `Date#toISOString`. */
const canonicalString = fc
  .record({
    year: fc.integer({ min: 0, max: 9999 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 59 }),
    ms: fc.integer({ min: 0, max: 999 }),
  })
  .filter(({ year, month, day }) => {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const max = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
    return day <= max;
  })
  .map(
    (f) =>
      `${pad(f.year, 4)}-${pad(f.month, 2)}-${pad(f.day, 2)}T${pad(f.hour, 2)}:${pad(f.minute, 2)}:${pad(f.second, 2)}.${pad(f.ms, 3)}Z`,
  );

const anyInstant = fc.integer({ min: MIN_ISO_MS, max: MAX_ISO_MS });

describe('toIso / fromIso round trip (property)', () => {
  it('toIso(fromIso(s)) === s for every canonical string', () => {
    fc.assert(
      fc.property(canonicalString, (s) => {
        expect(toIso(fromIso(s))).toBe(s);
      }),
      { numRuns: 2000 },
    );
  });

  it('fromIso(toIso(t)) is the same instant for every instant in range', () => {
    fc.assert(
      fc.property(anyInstant, (ms) => {
        const iso = toIso(ms);
        expect(iso).toMatch(CANONICAL);
        expect(iso).toHaveLength(24);
        expect(fromIso(iso).getTime()).toBe(ms);
        expect(toIso(new Date(ms))).toBe(iso);
      }),
      { numRuns: 2000 },
    );
  });

  it('canonical strings sort in the same order as their instants', () => {
    fc.assert(
      fc.property(anyInstant, anyInstant, (a, b) => {
        expect(toIso(a) < toIso(b)).toBe(a < b);
      }),
    );
  });

  it('rfc3339 normalisation agrees with the canonical parser on canonical input', () => {
    fc.assert(
      fc.property(canonicalString, (s) => {
        expect(normalizeIso(s)).toBe(s);
      }),
    );
  });
});

describe('toIso', () => {
  it('always writes Z and three fractional digits', () => {
    expect(toIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(toIso(new Date(Date.UTC(2026, 2, 8, 7, 0, 0, 5)))).toBe('2026-03-08T07:00:00.005Z');
  });

  it('covers the full four-digit-year range, including years 0-99', () => {
    expect(toIso(MIN_ISO_MS)).toBe('0000-01-01T00:00:00.000Z');
    expect(toIso(MAX_ISO_MS)).toBe('9999-12-31T23:59:59.999Z');
    expect(toIso(fromIso('0099-12-31T23:59:59.999Z'))).toBe('0099-12-31T23:59:59.999Z');
  });

  it('rejects instants that need an expanded (six-digit) year', () => {
    expect(reasonOf(() => toIso(MIN_ISO_MS - 1))).toBe('year_out_of_range');
    expect(reasonOf(() => toIso(MAX_ISO_MS + 1))).toBe('year_out_of_range');
    expect(reasonOf(() => toIso(8.64e15))).toBe('year_out_of_range');
  });

  it('rejects invalid dates and non-finite numbers', () => {
    expect(reasonOf(() => toIso(new Date(Number.NaN)))).toBe('invalid_date');
    expect(reasonOf(() => toIso(new Date('not a date')))).toBe('invalid_date');
    expect(reasonOf(() => toIso(Number.NaN))).toBe('invalid_date');
    expect(reasonOf(() => toIso(Number.POSITIVE_INFINITY))).toBe('invalid_date');
    expect(reasonOf(() => toIso(9e15))).toBe('invalid_date');
  });

  it('rejects values that are not a Date or a number', () => {
    expect(reasonOf(() => toIso('2026-01-01T00:00:00.000Z' as unknown as Date))).toBe(
      'invalid_type',
    );
    expect(reasonOf(() => toIso(null as unknown as Date))).toBe('invalid_type');
  });

  it("reads the Date's internal time value, not an overridden getTime", () => {
    const date = new Date(0);
    Object.defineProperty(date, 'getTime', { value: () => 1_000 });
    expect(toIso(date)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('accepts Dates from another realm', async () => {
    const { runInNewContext } = await import('node:vm');
    const foreign = runInNewContext('new Date(86400000)') as Date;
    expect(toIso(foreign)).toBe('1970-01-02T00:00:00.000Z');
  });
});

describe('fromIso (canonical, the default)', () => {
  it('returns a fresh Date each call', () => {
    const a = fromIso('2026-01-01T00:00:00.000Z');
    const b = fromIso('2026-01-01T00:00:00.000Z');
    expect(a).not.toBe(b);
    expect(a.getTime()).toBe(Date.UTC(2026, 0, 1));
  });

  it('rejects date-times without a UTC designator (never read in the host zone)', () => {
    expect(reasonOf(() => fromIso('2026-03-08T02:30:00.000'))).toBe('missing_offset');
    expect(reasonOf(() => fromIso('2026-03-08T02:30:00'))).toBe('missing_offset');
  });

  it('rejects non-UTC offsets instead of silently converting', () => {
    expect(reasonOf(() => fromIso('2026-03-08T02:30:00.000-05:00'))).toBe('not_utc');
    expect(reasonOf(() => fromIso('2026-03-08T02:30:00.000+00:00'))).toBe('not_utc');
  });

  it.each([
    ['date only', '2026-03-08'],
    ['no milliseconds', '2026-03-08T07:00:00Z'],
    ['one fractional digit', '2026-03-08T07:00:00.5Z'],
    ['six fractional digits', '2026-03-08T07:00:00.000000Z'],
    ['lowercase z', '2026-03-08T07:00:00.000z'],
    ['lowercase t', '2026-03-08t07:00:00.000Z'],
    ['space separator', '2026-03-08 07:00:00.000Z'],
    ['basic format', '20260308T070000.000Z'],
    ['expanded year', '+002026-03-08T07:00:00.000Z'],
    ['two-digit year', '26-03-08T07:00:00.000Z'],
    ['week date', '2026-W10-7T07:00:00.000Z'],
    ['ordinal date', '2026-067T07:00:00.000Z'],
    ['trailing space', '2026-03-08T07:00:00.000Z '],
    ['leading space', ' 2026-03-08T07:00:00.000Z'],
    ['trailing newline', '2026-03-08T07:00:00.000Z\n'],
    ['empty', ''],
    ['prose', 'yesterday'],
    ['non-ASCII digits', '２０２６-03-08T07:00:00.000Z'],
  ])('rejects %s as malformed', (_label, text) => {
    expect(reasonOf(() => fromIso(text))).toBe('malformed');
  });

  it.each([
    ['month 00', '2026-00-10T00:00:00.000Z'],
    ['month 13', '2026-13-10T00:00:00.000Z'],
    ['day 00', '2026-01-00T00:00:00.000Z'],
    ['30 February', '2026-02-30T00:00:00.000Z'],
    ['29 February in a common year', '2026-02-29T00:00:00.000Z'],
    ['29 February 1900', '1900-02-29T00:00:00.000Z'],
    ['31 April', '2026-04-31T00:00:00.000Z'],
    ['hour 24', '2026-01-01T24:00:00.000Z'],
    ['minute 60', '2026-01-01T00:60:00.000Z'],
    ['second 61', '2026-01-01T00:00:61.000Z'],
  ])('rejects %s as out of range', (_label, text) => {
    expect(reasonOf(() => fromIso(text))).toBe('out_of_range');
  });

  it('accepts 29 February in leap years (2024, 2000)', () => {
    expect(toIso(fromIso('2024-02-29T12:00:00.000Z'))).toBe('2024-02-29T12:00:00.000Z');
    expect(toIso(fromIso('2000-02-29T12:00:00.000Z'))).toBe('2000-02-29T12:00:00.000Z');
  });

  it('rejects leap seconds: they are not representable in ECMAScript time', () => {
    expect(reasonOf(() => fromIso('2016-12-31T23:59:60.000Z'))).toBe('leap_second');
    expect(reasonOf(() => fromIso('2016-12-31T23:59:60.000Z', { accept: 'rfc3339' }))).toBe(
      'leap_second',
    );
    // The instant after 23:59:59.999 is 00:00:00.000 of the next day: no 61-second minute exists.
    expect(toIso(fromIso('2016-12-31T23:59:59.999Z').getTime() + 1)).toBe(
      '2017-01-01T00:00:00.000Z',
    );
  });

  it('rejects non-strings and oversized input', () => {
    expect(reasonOf(() => fromIso(1_700_000_000_000 as unknown as string))).toBe('invalid_type');
    expect(reasonOf(() => fromIso(undefined as unknown as string))).toBe('invalid_type');
    expect(reasonOf(() => fromIso(`${'9'.repeat(10_000)}-01-01T00:00:00.000Z`))).toBe('malformed');
  });

  it('never echoes the rejected input in the message', () => {
    const secret = '2026-01-01T00:00:00.000Zsk-ant-secret';
    let caught: unknown;
    try {
      fromIso(secret);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TimeValidationError);
    expect((caught as Error).message).not.toContain('sk-ant');
  });
});

describe('fromIso (rfc3339) and normalizeIso', () => {
  it('normalises explicit offsets to UTC', () => {
    expect(normalizeIso('2026-03-08T02:30:00-05:00')).toBe('2026-03-08T07:30:00.000Z');
    expect(normalizeIso('2026-03-08T02:30:00+05:30')).toBe('2026-03-07T21:00:00.000Z');
    expect(normalizeIso('2026-01-01T00:00:00+23:59')).toBe('2025-12-31T00:01:00.000Z');
    expect(normalizeIso('2026-01-01T00:00:00-00:00')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts lowercase t/z and 0-9 fractional digits, truncating below a millisecond', () => {
    expect(normalizeIso('2026-03-08t07:00:00z')).toBe('2026-03-08T07:00:00.000Z');
    expect(normalizeIso('2026-03-08T07:00:00.5Z')).toBe('2026-03-08T07:00:00.500Z');
    expect(normalizeIso('2026-03-08T07:00:00.12Z')).toBe('2026-03-08T07:00:00.120Z');
    expect(normalizeIso('2026-03-08T07:00:00.999999999Z')).toBe('2026-03-08T07:00:00.999Z');
    expect(normalizeIso('2026-03-08T07:00:00.0001Z')).toBe('2026-03-08T07:00:00.000Z');
  });

  it('rejects missing offsets: a bare local time would depend on the host zone', () => {
    expect(reasonOf(() => normalizeIso('2026-03-08T02:30:00'))).toBe('missing_offset');
    expect(reasonOf(() => normalizeIso('2026-03-08T02:30:00.123456'))).toBe('missing_offset');
  });

  it('rejects offsets outside ±23:59 and malformed offsets', () => {
    expect(reasonOf(() => normalizeIso('2026-03-08T02:30:00+24:00'))).toBe('out_of_range');
    expect(reasonOf(() => normalizeIso('2026-03-08T02:30:00+05:60'))).toBe('out_of_range');
    expect(reasonOf(() => normalizeIso('2026-03-08T02:30:00+0530'))).toBe('malformed');
    expect(reasonOf(() => normalizeIso('2026-03-08T02:30:00+05'))).toBe('malformed');
    expect(reasonOf(() => normalizeIso('2026-03-08T02:30:00.Z'))).toBe('malformed');
    expect(reasonOf(() => normalizeIso('2026-03-08T02:30:00.1234567890Z'))).toBe('malformed');
  });

  it('rejects offsets that move the instant outside years 0000-9999', () => {
    expect(reasonOf(() => normalizeIso('0000-01-01T00:00:00+00:01'))).toBe('year_out_of_range');
    expect(reasonOf(() => normalizeIso('9999-12-31T23:59:59-00:01'))).toBe('year_out_of_range');
  });

  it('validates calendar fields like the canonical parser', () => {
    expect(reasonOf(() => normalizeIso('2026-02-30T00:00:00Z'))).toBe('out_of_range');
  });
});

describe('isIsoTimestamp', () => {
  it('is true only for canonical, real instants', () => {
    expect(isIsoTimestamp('2026-03-08T07:00:00.000Z')).toBe(true);
    expect(isIsoTimestamp('2026-03-08T07:00:00Z')).toBe(false);
    expect(isIsoTimestamp('2026-02-30T07:00:00.000Z')).toBe(false);
    expect(isIsoTimestamp(0)).toBe(false);
    expect(isIsoTimestamp(null)).toBe(false);
  });
});

describe('civilToUtcMs / instantToMs', () => {
  it('rejects non-integer fields', () => {
    expect(
      reasonOf(() =>
        civilToUtcMs({
          year: 2026,
          month: 1.5,
          day: 1,
          hour: 0,
          minute: 0,
          second: 0,
          millisecond: 0,
        }),
      ),
    ).toBe('invalid_type');
    expect(
      reasonOf(() =>
        civilToUtcMs({
          year: 10_000,
          month: 1,
          day: 1,
          hour: 0,
          minute: 0,
          second: 0,
          millisecond: 0,
        }),
      ),
    ).toBe('year_out_of_range');
    expect(
      reasonOf(() =>
        civilToUtcMs({
          year: 2026,
          month: 1,
          day: 1,
          hour: 0,
          minute: 0,
          second: 0,
          millisecond: 1000,
        }),
      ),
    ).toBe('out_of_range');
  });

  it('truncates fractional milliseconds like Date does', () => {
    expect(instantToMs(1.9)).toBe(1);
  });
});

describe('TimeValidationError', () => {
  it('is a ValidationError that maps to a 422 problem without echoing input', () => {
    const error = new TimeValidationError(
      'malformed',
      'timestamp must be YYYY-MM-DDTHH:mm:ss.sssZ',
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.httpStatus).toBe(422);
    expect(error.retryable).toBe(false);
    expect(error.name).toBe('ValidationError');
    const problem = toProblemDetails(error, '0af7651916cd43dd8448eb211c80319c', {
      environment: 'test',
    });
    expect(problem.status).toBe(422);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.detail).toBe('timestamp must be YYYY-MM-DDTHH:mm:ss.sssZ');
  });
});
