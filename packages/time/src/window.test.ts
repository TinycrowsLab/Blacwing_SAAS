import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TimeValidationError, type TimeValidationReason } from './errors.js';
import { fromIso, toIso } from './iso.js';
import { assertTimeWindow, isWithinWindow, parseTimeOfDay, type TimeWindow } from './window.js';

function reasonOf(fn: () => unknown): TimeValidationReason {
  try {
    fn();
  } catch (error) {
    if (error instanceof TimeValidationError) return error.reason;
    throw error;
  }
  throw new Error('expected a TimeValidationError');
}

const MINUTE = 60_000;
const at = (iso: string): Date => fromIso(iso);

/** The maximal runs of instants inside `window`, sampled every minute over [from, to). */
function openIntervals(window: TimeWindow, from: string, to: string): string[] {
  const runs: string[] = [];
  let openedAt: number | undefined;
  const end = fromIso(to).getTime();
  for (let ms = fromIso(from).getTime(); ms < end; ms += MINUTE) {
    const inside = isWithinWindow(ms, window);
    if (inside && openedAt === undefined) openedAt = ms;
    if (!inside && openedAt !== undefined) {
      runs.push(`${toIso(openedAt)}/${toIso(ms)}`);
      openedAt = undefined;
    }
  }
  if (openedAt !== undefined) runs.push(`${toIso(openedAt)}/${toIso(end)}`);
  return runs;
}

describe('isWithinWindow: DST spring forward (acceptance)', () => {
  // America/New_York, Sunday 2026-03-08: 02:00 EST (07:00Z) jumps to 03:00 EDT.
  const tz = 'America/New_York';

  it('a 01:30-02:30 window is open only until the clock jumps (30 real minutes)', () => {
    const window = { tz, start: '01:30', end: '02:30' };
    expect(isWithinWindow(at('2026-03-08T06:29:59.999Z'), window)).toBe(false); // 01:29:59.999 EST
    expect(isWithinWindow(at('2026-03-08T06:30:00.000Z'), window)).toBe(true); // 01:30 EST
    expect(isWithinWindow(at('2026-03-08T06:59:59.999Z'), window)).toBe(true); // 01:59:59.999 EST
    expect(isWithinWindow(at('2026-03-08T07:00:00.000Z'), window)).toBe(false); // 03:00 EDT
    expect(isWithinWindow(at('2026-03-08T07:30:00.000Z'), window)).toBe(false); // 03:30 EDT (02:30 + 1 h)
    expect(openIntervals(window, '2026-03-08T00:00:00.000Z', '2026-03-09T00:00:00.000Z')).toEqual([
      '2026-03-08T06:30:00.000Z/2026-03-08T07:00:00.000Z',
    ]);
  });

  it('a window wholly inside the gap does not open that day, and opens normally the next', () => {
    const window = { tz, start: '02:00', end: '03:00' };
    expect(openIntervals(window, '2026-03-08T05:00:00.000Z', '2026-03-09T05:00:00.000Z')).toEqual(
      [],
    );
    expect(openIntervals(window, '2026-03-09T05:00:00.000Z', '2026-03-10T05:00:00.000Z')).toEqual([
      '2026-03-09T06:00:00.000Z/2026-03-09T07:00:00.000Z',
    ]);
  });

  it('a window spanning the gap is one real hour shorter', () => {
    const window = { tz, start: '01:00', end: '04:00' };
    expect(openIntervals(window, '2026-03-08T05:00:00.000Z', '2026-03-09T05:00:00.000Z')).toEqual([
      '2026-03-08T06:00:00.000Z/2026-03-08T08:00:00.000Z',
    ]);
  });

  it('an overnight 22:00-06:00 window across the gap is 7 real hours', () => {
    const window = { tz, start: '22:00', end: '06:00' };
    expect(openIntervals(window, '2026-03-07T12:00:00.000Z', '2026-03-08T12:00:00.000Z')).toEqual([
      '2026-03-08T03:00:00.000Z/2026-03-08T10:00:00.000Z',
    ]);
  });
});

describe('isWithinWindow: DST fall back', () => {
  it('New York 01:00-02:00 on 2026-11-01 is open during both occurrences (2 real hours)', () => {
    const window = { tz: 'America/New_York', start: '01:00', end: '02:00' };
    expect(isWithinWindow(at('2026-11-01T05:30:00.000Z'), window)).toBe(true); // 01:30 EDT
    expect(isWithinWindow(at('2026-11-01T06:30:00.000Z'), window)).toBe(true); // 01:30 EST
    expect(openIntervals(window, '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z')).toEqual([
      '2026-11-01T05:00:00.000Z/2026-11-01T07:00:00.000Z',
    ]);
  });

  it('a window inside the repeated hour opens twice', () => {
    const window = { tz: 'America/New_York', start: '01:30', end: '01:45' };
    expect(openIntervals(window, '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z')).toEqual([
      '2026-11-01T05:30:00.000Z/2026-11-01T05:45:00.000Z',
      '2026-11-01T06:30:00.000Z/2026-11-01T06:45:00.000Z',
    ]);
  });

  it('an overnight window across the overlap is one real hour longer', () => {
    const window = { tz: 'America/New_York', start: '22:00', end: '06:00' };
    expect(openIntervals(window, '2026-10-31T12:00:00.000Z', '2026-11-01T18:00:00.000Z')).toEqual([
      '2026-11-01T02:00:00.000Z/2026-11-01T11:00:00.000Z',
    ]);
  });
});

describe('isWithinWindow: other IANA zones', () => {
  it('Europe/London: the 01:00-02:00 gap on 2026-03-29 never opens; the overlap on 2026-10-25 opens twice', () => {
    expect(
      openIntervals(
        { tz: 'Europe/London', start: '01:00', end: '02:00' },
        '2026-03-28T22:00:00.000Z',
        '2026-03-29T22:00:00.000Z',
      ),
    ).toEqual([]);
    expect(
      openIntervals(
        { tz: 'Europe/London', start: '00:30', end: '01:30' },
        '2026-03-28T22:00:00.000Z',
        '2026-03-29T22:00:00.000Z',
      ),
    ).toEqual(['2026-03-29T00:30:00.000Z/2026-03-29T01:00:00.000Z']);
    expect(
      openIntervals(
        { tz: 'Europe/London', start: '01:15', end: '01:45' },
        '2026-10-24T22:00:00.000Z',
        '2026-10-25T22:00:00.000Z',
      ),
    ).toEqual([
      '2026-10-25T00:15:00.000Z/2026-10-25T00:45:00.000Z',
      '2026-10-25T01:15:00.000Z/2026-10-25T01:45:00.000Z',
    ]);
  });

  it('Australia/Sydney (southern hemisphere): overlap on 2026-04-05, gap on 2026-10-04', () => {
    const window = { tz: 'Australia/Sydney', start: '02:00', end: '03:00' };
    expect(openIntervals(window, '2026-04-04T12:00:00.000Z', '2026-04-05T12:00:00.000Z')).toEqual([
      '2026-04-04T15:00:00.000Z/2026-04-04T17:00:00.000Z',
    ]);
    expect(openIntervals(window, '2026-10-03T12:00:00.000Z', '2026-10-04T12:00:00.000Z')).toEqual(
      [],
    );
  });

  it('Australia/Lord_Howe: 30-minute gap and overlap', () => {
    expect(
      openIntervals(
        { tz: 'Australia/Lord_Howe', start: '02:00', end: '02:30' },
        '2026-10-03T12:00:00.000Z',
        '2026-10-04T12:00:00.000Z',
      ),
    ).toEqual([]);
    expect(
      openIntervals(
        { tz: 'Australia/Lord_Howe', start: '01:45', end: '02:45' },
        '2026-10-03T12:00:00.000Z',
        '2026-10-04T12:00:00.000Z',
      ),
    ).toEqual(['2026-10-03T15:15:00.000Z/2026-10-03T15:45:00.000Z']); // 01:45-02:00 (+10:30), then 02:30-02:45 (+11:00)
    expect(
      openIntervals(
        { tz: 'Australia/Lord_Howe', start: '01:30', end: '02:00' },
        '2026-04-04T12:00:00.000Z',
        '2026-04-05T12:00:00.000Z',
      ),
    ).toEqual(['2026-04-04T14:30:00.000Z/2026-04-04T15:30:00.000Z']);
  });

  it('America/Havana: local midnight does not exist on 2026-03-08', () => {
    expect(
      openIntervals(
        { tz: 'America/Havana', start: '00:00', end: '01:00' },
        '2026-03-07T12:00:00.000Z',
        '2026-03-08T12:00:00.000Z',
      ),
    ).toEqual([]);
    // Saturday 23:00 CST to Sunday 01:30 CDT: 1.5 real hours, attributed to Saturday (6).
    const overnight = { tz: 'America/Havana', start: '23:00', end: '01:30' };
    expect(
      openIntervals(overnight, '2026-03-07T12:00:00.000Z', '2026-03-08T12:00:00.000Z'),
    ).toEqual(['2026-03-08T04:00:00.000Z/2026-03-08T05:30:00.000Z']);
    expect(isWithinWindow(at('2026-03-08T05:15:00.000Z'), { ...overnight, days: [6] })).toBe(true);
    expect(isWithinWindow(at('2026-03-08T05:15:00.000Z'), { ...overnight, days: [7] })).toBe(false);
  });

  it('Asia/Kolkata (+05:30, no DST) and Pacific/Chatham (+12:45/+13:45)', () => {
    const office = { tz: 'Asia/Kolkata', start: '09:00', end: '17:00' };
    expect(isWithinWindow(at('2026-01-15T03:29:59.999Z'), office)).toBe(false);
    expect(isWithinWindow(at('2026-01-15T03:30:00.000Z'), office)).toBe(true);
    expect(isWithinWindow(at('2026-01-15T11:29:59.999Z'), office)).toBe(true);
    expect(isWithinWindow(at('2026-01-15T11:30:00.000Z'), office)).toBe(false);
    expect(
      isWithinWindow(at('2026-01-15T00:00:00.000Z'), {
        tz: 'Pacific/Chatham',
        start: '13:45',
        end: '13:46',
      }),
    ).toBe(true);
  });

  it('Pacific/Apia: a window that opens on the skipped Friday 2011-12-30 never opens', () => {
    const friday = { tz: 'Pacific/Apia', start: '09:00', end: '17:00', days: [5] } as const;
    expect(openIntervals(friday, '2011-12-28T00:00:00.000Z', '2012-01-02T00:00:00.000Z')).toEqual(
      [],
    );
    expect(openIntervals(friday, '2012-01-05T00:00:00.000Z', '2012-01-07T00:00:00.000Z')).toEqual([
      '2012-01-05T19:00:00.000Z/2012-01-06T03:00:00.000Z',
    ]);
  });
});

describe('isWithinWindow: bounds and days', () => {
  const utc = (start: string, end: string, days?: TimeWindow['days']): TimeWindow =>
    days === undefined ? { tz: 'UTC', start, end } : { tz: 'UTC', start, end, days };

  it('is half-open: start inclusive, end exclusive, at millisecond precision', () => {
    expect(isWithinWindow(at('2026-01-15T08:59:59.999Z'), utc('09:00', '17:00'))).toBe(false);
    expect(isWithinWindow(at('2026-01-15T09:00:00.000Z'), utc('09:00', '17:00'))).toBe(true);
    expect(isWithinWindow(at('2026-01-15T16:59:59.999Z'), utc('09:00', '17:00'))).toBe(true);
    expect(isWithinWindow(at('2026-01-15T17:00:00.000Z'), utc('09:00', '17:00'))).toBe(false);
  });

  it('supports seconds and 24:00 as the end of the day', () => {
    expect(isWithinWindow(at('2026-01-15T09:00:29.999Z'), utc('09:00:30', '10:00'))).toBe(false);
    expect(isWithinWindow(at('2026-01-15T23:59:59.999Z'), utc('18:00', '24:00'))).toBe(true);
    expect(isWithinWindow(at('2026-01-16T00:00:00.000Z'), utc('18:00', '24:00'))).toBe(false);
    expect(isWithinWindow(at('2026-01-16T00:00:00.000Z'), utc('00:00', '24:00'))).toBe(true);
  });

  it('an overnight window crosses midnight', () => {
    const night = utc('22:00', '06:00');
    expect(isWithinWindow(at('2026-01-15T21:59:59.999Z'), night)).toBe(false);
    expect(isWithinWindow(at('2026-01-15T22:00:00.000Z'), night)).toBe(true);
    expect(isWithinWindow(at('2026-01-16T05:59:59.999Z'), night)).toBe(true);
    expect(isWithinWindow(at('2026-01-16T06:00:00.000Z'), night)).toBe(false);
    expect(isWithinWindow(at('2026-01-16T12:00:00.000Z'), night)).toBe(false);
  });

  it('days are the local days the window opens on; the after-midnight part belongs to the opening day', () => {
    // 2026-01-16 is a Friday (5), 2026-01-17 a Saturday (6), 2026-01-19 a Monday (1).
    const fridayNight = utc('22:00', '02:00', [5]);
    expect(isWithinWindow(at('2026-01-16T23:00:00.000Z'), fridayNight)).toBe(true);
    expect(isWithinWindow(at('2026-01-17T01:00:00.000Z'), fridayNight)).toBe(true);
    expect(isWithinWindow(at('2026-01-17T23:00:00.000Z'), fridayNight)).toBe(false);
    expect(isWithinWindow(at('2026-01-16T01:00:00.000Z'), fridayNight)).toBe(false);
    const sundayNight = utc('22:00', '02:00', [7]);
    expect(isWithinWindow(at('2026-01-19T01:00:00.000Z'), sundayNight)).toBe(true);
    const weekdays = utc('09:00', '17:00', [1, 2, 3, 4, 5]);
    expect(isWithinWindow(at('2026-01-16T10:00:00.000Z'), weekdays)).toBe(true);
    expect(isWithinWindow(at('2026-01-17T10:00:00.000Z'), weekdays)).toBe(false);
  });

  it("uses the weekday in the window's zone, not in UTC", () => {
    // 2026-01-16T23:30Z is Friday in UTC but already Saturday in Tokyo.
    expect(
      isWithinWindow(at('2026-01-16T23:30:00.000Z'), {
        tz: 'Asia/Tokyo',
        start: '08:00',
        end: '09:00',
        days: [6],
      }),
    ).toBe(true);
    expect(
      isWithinWindow(at('2026-01-16T23:30:00.000Z'), {
        tz: 'Asia/Tokyo',
        start: '08:00',
        end: '09:00',
        days: [5],
      }),
    ).toBe(false);
  });

  it('swapping start and end gives the exact complement, in any zone (property)', () => {
    const time = fc
      .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
      .map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2040, 0, 1) }),
        time,
        time,
        fc.constantFrom(
          'America/New_York',
          'Europe/London',
          'Australia/Lord_Howe',
          'America/Havana',
          'Asia/Kolkata',
        ),
        (ms, start, end, tz) => {
          fc.pre(start !== end);
          expect(isWithinWindow(ms, { tz, start, end })).toBe(
            !isWithinWindow(ms, { tz, start: end, end: start }),
          );
        },
      ),
      { numRuns: 1000 },
    );
  }, 60_000);

  it('matches a fixed-offset reference in a zone without DST (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2040, 0, 1) }), (ms) => {
        const minuteOfDay = Math.floor(
          ((((ms + 330 * MINUTE) % 86_400_000) + 86_400_000) % 86_400_000) / MINUTE,
        );
        const expected = minuteOfDay >= 9 * 60 && minuteOfDay < 17 * 60;
        expect(isWithinWindow(ms, { tz: 'Asia/Kolkata', start: '09:00', end: '17:00' })).toBe(
          expected,
        );
      }),
      { numRuns: 1000 },
    );
  }, 60_000);
});

describe('window validation (fails closed by throwing)', () => {
  const now = at('2026-01-15T12:00:00.000Z');

  it.each([
    ['start equals end', { tz: 'UTC', start: '09:00', end: '09:00' }, 'invalid_window'],
    ['00:00 to 00:00', { tz: 'UTC', start: '00:00', end: '00:00' }, 'invalid_window'],
    ['24:00 as start', { tz: 'UTC', start: '24:00', end: '06:00' }, 'invalid_time_of_day'],
    ['hour 25', { tz: 'UTC', start: '25:00', end: '06:00' }, 'invalid_time_of_day'],
    ['minute 60', { tz: 'UTC', start: '12:60', end: '13:00' }, 'invalid_time_of_day'],
    ['leap second', { tz: 'UTC', start: '23:59:60', end: '23:59:59' }, 'invalid_time_of_day'],
    ['24:30 as end', { tz: 'UTC', start: '09:00', end: '24:30' }, 'invalid_time_of_day'],
    ['single-digit hour', { tz: 'UTC', start: '9:00', end: '17:00' }, 'invalid_time_of_day'],
    ['12-hour clock', { tz: 'UTC', start: '9am', end: '5pm' }, 'invalid_time_of_day'],
    ['empty days', { tz: 'UTC', start: '09:00', end: '17:00', days: [] }, 'invalid_window'],
    ['day 0', { tz: 'UTC', start: '09:00', end: '17:00', days: [0] }, 'invalid_window'],
    ['day 8', { tz: 'UTC', start: '09:00', end: '17:00', days: [8] }, 'invalid_window'],
    ['fractional day', { tz: 'UTC', start: '09:00', end: '17:00', days: [1.5] }, 'invalid_window'],
    ['string day', { tz: 'UTC', start: '09:00', end: '17:00', days: ['1'] }, 'invalid_window'],
    ['host zone alias', { tz: 'local', start: '09:00', end: '17:00' }, 'invalid_time_zone'],
    ['system zone alias', { tz: 'system', start: '09:00', end: '17:00' }, 'invalid_time_zone'],
    [
      'offset instead of a zone',
      { tz: '+05:30', start: '09:00', end: '17:00' },
      'invalid_time_zone',
    ],
    [
      'unknown zone',
      { tz: 'Mars/Olympus_Mons', start: '09:00', end: '17:00' },
      'invalid_time_zone',
    ],
    ['missing zone', { start: '09:00', end: '17:00' }, 'invalid_time_zone'],
    ['missing start', { tz: 'UTC', end: '17:00' }, 'invalid_type'],
  ])('rejects %s', (_label, window, reason) => {
    expect(reasonOf(() => isWithinWindow(now, window as unknown as TimeWindow))).toBe(reason);
    expect(reasonOf(() => assertTimeWindow(window as unknown as TimeWindow))).toBe(reason);
  });

  it('rejects a non-object window and an invalid instant', () => {
    expect(reasonOf(() => isWithinWindow(now, null as unknown as TimeWindow))).toBe('invalid_type');
    expect(
      reasonOf(() =>
        isWithinWindow(new Date(Number.NaN), { tz: 'UTC', start: '09:00', end: '17:00' }),
      ),
    ).toBe('invalid_date');
  });

  it('assertTimeWindow returns a valid window unchanged', () => {
    const window = {
      tz: 'Europe/London',
      start: '22:00',
      end: '06:00',
      days: [1, 2, 3, 4, 5],
    } as const;
    expect(assertTimeWindow(window)).toBe(window);
  });
});

describe('parseTimeOfDay', () => {
  it('returns milliseconds after local midnight', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('09:30')).toBe(34_200_000);
    expect(parseTimeOfDay('23:59:59')).toBe(86_399_000);
    expect(parseTimeOfDay('24:00', { allowEndOfDay: true })).toBe(86_400_000);
    expect(parseTimeOfDay('24:00:00', { allowEndOfDay: true })).toBe(86_400_000);
  });

  it('rejects 24:00 unless asked, and non-strings', () => {
    expect(reasonOf(() => parseTimeOfDay('24:00'))).toBe('invalid_time_of_day');
    expect(reasonOf(() => parseTimeOfDay(900 as unknown as string))).toBe('invalid_type');
  });
});
