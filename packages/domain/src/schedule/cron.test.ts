import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AppError, ValidationError } from '@blackwing/errors';
import { toZoned } from '@blackwing/time';

import {
  isWithinWindow,
  nextFireAfter,
  nextNFires,
  parseSchedule,
  SCHEDULE_PREVIEW_MAX,
  type ScheduleSpec,
  WINDOW_DURATION_MAX_MINUTES,
} from './cron.js';

/** The machine-readable code of whatever `fn` throws, or undefined when it returns. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
}

/** Shorthand: a valid spec for a cron expression in a zone. */
function specOf(cronExpr: string, timezone: string): ScheduleSpec {
  return parseSchedule({ cronExpr, timezone });
}

const utc = (iso: string): Date => new Date(iso);

describe('parseSchedule', () => {
  it('returns the normalised expression and zone, collapsing whitespace', () => {
    expect(parseSchedule({ cronExpr: '  0   2 * *  * ', timezone: 'Europe/London' })).toEqual({
      cronExpr: '0 2 * * *',
      timezone: 'Europe/London',
      neverFires: false,
    });
  });

  it('expands each documented shortcut to its five-field form', () => {
    expect(specOf('@hourly', 'UTC').cronExpr).toBe('0 * * * *');
    expect(specOf('@daily', 'UTC').cronExpr).toBe('0 0 * * *');
    expect(specOf('@weekly', 'UTC').cronExpr).toBe('0 0 * * 0');
    expect(specOf('@monthly', 'UTC').cronExpr).toBe('0 0 1 * *');
    expect(specOf('@yearly', 'UTC').cronExpr).toBe('0 0 1 1 *');
  });

  it('refuses shortcuts outside the documented set, such as @reboot', () => {
    expect(codeOf(() => specOf('@reboot', 'UTC'))).toBe('SCHEDULE_CRON_INVALID');
    expect(codeOf(() => specOf('@annually', 'UTC'))).toBe('SCHEDULE_CRON_INVALID');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['four fields', '0 2 * *'],
    ['six fields (seconds are not supported)', '0 0 2 * * *'],
    ['out-of-range minute', '61 * * * *'],
    ['out-of-range hour', '0 25 * * *'],
    ['unknown name', '0 2 * * FUNDAY'],
    ['injected text', '0 2 * * * ; rm -rf /'],
  ])('refuses a bad cron expression (%s) with SCHEDULE_CRON_INVALID', (_label, cronExpr) => {
    expect(codeOf(() => specOf(cronExpr, 'Europe/London'))).toBe('SCHEDULE_CRON_INVALID');
  });

  it('refuses a non-string or over-length expression with SCHEDULE_CRON_INVALID', () => {
    expect(
      codeOf(() => parseSchedule({ cronExpr: 42 as unknown as string, timezone: 'UTC' })),
    ).toBe('SCHEDULE_CRON_INVALID');
    const tooLong = `0 2 * * * ${'x'.repeat(300)}`;
    expect(codeOf(() => specOf(tooLong, 'UTC'))).toBe('SCHEDULE_CRON_INVALID');
  });

  it.each([
    ['an unknown zone', 'Mars/Olympus'],
    ['a host alias', 'local'],
    ['a fixed offset', '+03:00'],
    ['a wrong-case name', 'europe/london'],
    ['an empty string', ''],
  ])('refuses %s with SCHEDULE_TZ_INVALID', (_label, timezone) => {
    expect(codeOf(() => specOf('0 2 * * *', timezone))).toBe('SCHEDULE_TZ_INVALID');
  });

  it('refuses a non-string zone with SCHEDULE_TZ_INVALID', () => {
    expect(
      codeOf(() => parseSchedule({ cronExpr: '0 2 * * *', timezone: 7 as unknown as string })),
    ).toBe('SCHEDULE_TZ_INVALID');
  });

  it('accepts UTC, which the runtime does not list among its zones', () => {
    expect(specOf('0 2 * * *', 'UTC').timezone).toBe('UTC');
  });

  it('accepts a 30 February cron as valid but never firing', () => {
    expect(specOf('0 0 30 2 *', 'Europe/London').neverFires).toBe(true);
  });

  it('still validates the other fields of a never-firing expression', () => {
    expect(codeOf(() => specOf('61 0 30 2 *', 'Europe/London'))).toBe('SCHEDULE_CRON_INVALID');
  });

  it.each([
    ['every minute', '* * * * *'],
    ['every 30 minutes', '*/30 * * * *'],
    ['two minutes in one hour', '0,30 * * * *'],
    ['minutes 59 apart', '0,59 * * * *'],
  ])(
    'refuses a schedule firing more often than hourly (%s) with SCHEDULE_TOO_FREQUENT',
    (_label, cronExpr) => {
      expect(codeOf(() => specOf(cronExpr, 'Europe/London'))).toBe('SCHEDULE_TOO_FREQUENT');
    },
  );

  it.each([
    ['hourly', '0 * * * *'],
    ['hourly shortcut', '@hourly'],
    ['every two hours', '0 */2 * * *'],
    ['a fixed minute on several hours', '15 0,12 * * 1-5'],
  ])('accepts a schedule that fires no more often than hourly (%s)', (_label, cronExpr) => {
    expect(codeOf(() => specOf(cronExpr, 'Europe/London'))).toBeUndefined();
  });
});

describe('nextFireAfter', () => {
  describe('Europe/London, 0 2 * * *', () => {
    const spec = specOf('0 2 * * *', 'Europe/London');

    it('returns 02:00 GMT before the spring change', () => {
      expect(nextFireAfter(spec, utc('2026-03-27T12:00:00Z'))?.toISOString()).toBe(
        '2026-03-28T02:00:00.000Z',
      );
    });

    it('fires at 02:00 BST on 29 March, which is 01:00Z, the first instant after the change', () => {
      expect(nextFireAfter(spec, utc('2026-03-28T02:00:00Z'))?.toISOString()).toBe(
        '2026-03-29T01:00:00.000Z',
      );
      expect(nextFireAfter(spec, utc('2026-03-29T01:00:00Z'))?.toISOString()).toBe(
        '2026-03-30T01:00:00.000Z',
      );
    });

    it('returns 02:00 GMT after the autumn change', () => {
      expect(nextFireAfter(spec, utc('2026-10-24T12:00:00Z'))?.toISOString()).toBe(
        '2026-10-25T02:00:00.000Z',
      );
      expect(nextFireAfter(spec, utc('2026-10-25T02:00:00Z'))?.toISOString()).toBe(
        '2026-10-26T02:00:00.000Z',
      );
    });
  });

  describe('Europe/London, 30 1 * * * (DST boundaries)', () => {
    const spec = specOf('30 1 * * *', 'Europe/London');

    it('skips 01:30 on the spring-forward day, when 01:00 to 02:00 does not exist', () => {
      expect(nextFireAfter(spec, utc('2026-03-28T01:30:00Z'))?.toISOString()).toBe(
        '2026-03-30T00:30:00.000Z',
      );
    });

    it('fires once for the duplicated 01:30 on the fall-back day, at its first occurrence', () => {
      // 01:30 BST is 00:30Z; the repeated 01:30 GMT (01:30Z) must not fire again.
      expect(nextFireAfter(spec, utc('2026-10-24T12:00:00Z'))?.toISOString()).toBe(
        '2026-10-25T00:30:00.000Z',
      );
      expect(nextFireAfter(spec, utc('2026-10-25T00:30:00Z'))?.toISOString()).toBe(
        '2026-10-26T01:30:00.000Z',
      );
    });

    it('does not fire for a repeated wall time when the search starts between the two occurrences', () => {
      // 01:10Z is 01:10 GMT, after the first 01:30 BST (00:30Z) and before the second (01:30Z).
      expect(nextFireAfter(spec, utc('2026-10-25T01:10:00Z'))?.toISOString()).toBe(
        '2026-10-26T01:30:00.000Z',
      );
    });
  });

  describe('America/New_York', () => {
    it('skips 02:30 on the spring-forward day (2026-03-08)', () => {
      const spec = specOf('30 2 * * *', 'America/New_York');
      expect(nextFireAfter(spec, utc('2026-03-07T12:00:00Z'))?.toISOString()).toBe(
        '2026-03-09T06:30:00.000Z',
      );
    });

    it('fires 01:30 once on the fall-back day (2026-11-01), at 01:30 EDT', () => {
      const spec = specOf('30 1 * * *', 'America/New_York');
      expect(nextFireAfter(spec, utc('2026-11-01T00:00:00Z'))?.toISOString()).toBe(
        '2026-11-01T05:30:00.000Z',
      );
      expect(nextFireAfter(spec, utc('2026-11-01T05:30:00Z'))?.toISOString()).toBe(
        '2026-11-02T06:30:00.000Z',
      );
    });
  });

  it('returns the next fire strictly after an instant that is itself a fire', () => {
    const spec = specOf('0 2 * * *', 'Europe/London');
    expect(nextFireAfter(spec, utc('2026-03-28T02:00:00Z'))?.toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
  });

  it('treats the input as an absolute instant, regardless of its textual offset', () => {
    const spec = specOf('0 2 * * *', 'Europe/London');
    // 03:00+01:00 is 02:00Z, the same instant as 02:00Z, so the next fire is the one after it.
    expect(nextFireAfter(spec, new Date('2026-03-28T03:00:00+01:00'))?.toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
  });

  it('computes a fire years away', () => {
    const spec = specOf('@yearly', 'Europe/London');
    expect(nextFireAfter(spec, utc('2026-06-01T00:00:00Z'))?.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('returns null for a 30 February expression, which never fires', () => {
    expect(
      nextFireAfter(specOf('0 0 30 2 *', 'Europe/London'), utc('2026-01-01T00:00:00Z')),
    ).toBeNull();
  });

  it('returns null for an expression with no match within the search limit', () => {
    expect(nextFireAfter(specOf('0 0 31 4,6 *', 'UTC'), utc('2026-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('nextNFires', () => {
  it('returns the next n fires in increasing order, one per local day across DST', () => {
    const fires = nextNFires(specOf('0 2 * * *', 'Europe/London'), utc('2026-03-27T12:00:00Z'), 3);
    expect(fires.map((fire) => fire.toISOString())).toEqual([
      '2026-03-28T02:00:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-30T01:00:00.000Z',
    ]);
  });

  it('returns an empty list for a schedule that never fires', () => {
    expect(
      nextNFires(specOf('0 0 30 2 *', 'Europe/London'), utc('2026-01-01T00:00:00Z'), 5),
    ).toEqual([]);
  });

  it('accepts the preview cap and refuses anything above it', () => {
    const spec = specOf('@daily', 'UTC');
    const from = utc('2026-01-01T00:00:00Z');
    expect(nextNFires(spec, from, SCHEDULE_PREVIEW_MAX)).toHaveLength(SCHEDULE_PREVIEW_MAX);
    expect(() => nextNFires(spec, from, SCHEDULE_PREVIEW_MAX + 1)).toThrow(ValidationError);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a count of %s', (count) => {
    expect(() => nextNFires(specOf('@daily', 'UTC'), utc('2026-01-01T00:00:00Z'), count)).toThrow(
      ValidationError,
    );
  });

  it('keeps every fire strictly increasing, after the start, and at the scheduled wall time', () => {
    const zones = ['Europe/London', 'America/New_York', 'Australia/Sydney'] as const;
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2028, 0, 1) }),
        fc.constantFrom(...zones),
        fc.integer({ min: 1, max: SCHEDULE_PREVIEW_MAX }),
        (fromMs, timezone, n) => {
          const spec = specOf('0 2 * * *', timezone);
          const fires = nextNFires(spec, new Date(fromMs), n);
          expect(fires).toHaveLength(n);
          let previous = fromMs;
          for (const fire of fires) {
            expect(fire.getTime()).toBeGreaterThan(previous);
            const local = toZoned(fire, timezone);
            expect([local.hour, local.minute]).toEqual([2, 0]);
            previous = fire.getTime();
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('isWithinWindow', () => {
  it('is open from the fire instant, inclusive, until the duration ends, exclusive', () => {
    // 0 22 * * * in London, 120 minutes: open [22:00Z, 00:00Z) on 28 March.
    expect(isWithinWindow('0 22 * * *', 'Europe/London', 120, utc('2026-03-28T22:00:00Z'))).toBe(
      true,
    );
    expect(
      isWithinWindow('0 22 * * *', 'Europe/London', 120, utc('2026-03-28T23:59:59.999Z')),
    ).toBe(true);
    expect(isWithinWindow('0 22 * * *', 'Europe/London', 120, utc('2026-03-29T00:00:00Z'))).toBe(
      false,
    );
    expect(
      isWithinWindow('0 22 * * *', 'Europe/London', 120, utc('2026-03-28T21:59:59.999Z')),
    ).toBe(false);
  });

  it('opens a repeated fall-back window once, at its first occurrence', () => {
    // 30 1 * * * in New York on 1 November fires at 05:30Z (01:30 EDT) only. The window is [05:30Z, 06:30Z).
    const cron = '30 1 * * *';
    expect(isWithinWindow(cron, 'America/New_York', 60, utc('2026-11-01T06:00:00Z'))).toBe(true);
    expect(isWithinWindow(cron, 'America/New_York', 60, utc('2026-11-01T06:45:00Z'))).toBe(false);
  });

  it('allows a sub-hourly window, since its length bounds it', () => {
    expect(isWithinWindow('* * * * *', 'UTC', 1, utc('2026-01-01T10:00:30Z'))).toBe(true);
  });

  it('is never open for a schedule that never fires', () => {
    expect(isWithinWindow('0 0 30 2 *', 'UTC', 60, utc('2026-02-28T12:00:00Z'))).toBe(false);
  });

  it.each([0, -5, 1.5, WINDOW_DURATION_MAX_MINUTES + 1])('refuses a duration of %s', (duration) => {
    expect(() => isWithinWindow('0 2 * * *', 'UTC', duration, utc('2026-01-01T00:00:00Z'))).toThrow(
      ValidationError,
    );
  });

  it('refuses an invalid cron expression or zone with the schedule codes', () => {
    const at = utc('2026-01-01T00:00:00Z');
    expect(codeOf(() => isWithinWindow('61 * * * *', 'UTC', 60, at))).toBe('SCHEDULE_CRON_INVALID');
    expect(codeOf(() => isWithinWindow('0 2 * * *', 'Mars/Olympus', 60, at))).toBe(
      'SCHEDULE_TZ_INVALID',
    );
  });
});
