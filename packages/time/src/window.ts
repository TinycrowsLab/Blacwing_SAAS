import { TimeValidationError } from './errors.js';
import { isIsoWeekday, type IsoWeekday, toZoned } from './zone.js';

/**
 * A daily wall-clock window in an IANA time zone, such as a standing authorisation's permitted
 * test hours: `{ tz: "Europe/London", start: "22:00", end: "06:00", days: [1, 2, 3, 4, 5] }`.
 *
 * - `start` and `end` are `HH:mm` or `HH:mm:ss` local wall-clock times. The window is half-open,
 *   `[start, end)`. `end` may be `24:00` (end of the local day). `start === end` is rejected.
 * - `end` earlier than `start` means the window crosses local midnight.
 * - `days` (optional, ISO weekdays, 1 = Monday) are the local days on which the window **opens**;
 *   the after-midnight part of an overnight window belongs to the day it opened on. Omitted means
 *   every day.
 *
 * This is the primitive the standing-authorisation and scheduler epics build their cron-like
 * windows on; evaluating cron expressions is theirs, not this package's.
 */
export interface TimeWindow {
  readonly tz: string;
  readonly start: string;
  readonly end: string;
  readonly days?: readonly IsoWeekday[];
}

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const END_OF_DAY_HOUR = 24;
const MAX_HOUR = 23;
const MAX_MINUTE = 59;
const MAX_SECOND = 59;
const SUNDAY: IsoWeekday = 7;
const TIME_OF_DAY = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Options for {@link parseTimeOfDay}. */
export interface ParseTimeOfDayOptions {
  /** Accept `24:00` / `24:00:00` as the end of the day (86 400 000 ms). Default false. */
  readonly allowEndOfDay?: boolean;
}

/**
 * Milliseconds after local midnight for a wall-clock time `HH:mm` or `HH:mm:ss` (00:00 to 23:59:59).
 * Throws `invalid_time_of_day` for anything else; second 60 is rejected like everywhere else.
 */
export function parseTimeOfDay(text: string, options: ParseTimeOfDayOptions = {}): number {
  if (typeof text !== 'string')
    throw new TimeValidationError('invalid_type', 'time of day must be a string');
  const match = TIME_OF_DAY.exec(text);
  if (match === null)
    throw new TimeValidationError('invalid_time_of_day', 'time of day must be HH:mm or HH:mm:ss');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? '0');
  if (options.allowEndOfDay === true && hour === END_OF_DAY_HOUR && minute === 0 && second === 0)
    return MS_PER_DAY;
  if (hour > MAX_HOUR || minute > MAX_MINUTE || second > MAX_SECOND) {
    throw new TimeValidationError(
      'invalid_time_of_day',
      'time of day must be between 00:00 and 23:59:59',
    );
  }
  return hour * MS_PER_HOUR + minute * MS_PER_MINUTE + second * MS_PER_SECOND;
}

interface ParsedWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly days: ReadonlySet<number> | undefined;
}

function parseWindow(window: TimeWindow): ParsedWindow {
  // Callers may hand over unvalidated input despite the type; refuse anything but an object.
  const value: unknown = window;
  if (typeof value !== 'object' || value === null)
    throw new TimeValidationError('invalid_type', 'window must be an object');
  const startMs = parseTimeOfDay(window.start);
  const endMs = parseTimeOfDay(window.end, { allowEndOfDay: true });
  if (startMs === endMs)
    throw new TimeValidationError('invalid_window', 'window start and end must differ');
  let days: ReadonlySet<number> | undefined;
  if (window.days !== undefined) {
    if (!Array.isArray(window.days) || window.days.length === 0) {
      throw new TimeValidationError(
        'invalid_window',
        'window days must be a non-empty list of ISO weekdays',
      );
    }
    for (const day of window.days as readonly unknown[]) {
      if (!isIsoWeekday(day)) {
        throw new TimeValidationError(
          'invalid_window',
          'window days must be ISO weekdays 1 (Monday) to 7 (Sunday)',
        );
      }
    }
    days = new Set(window.days);
  }
  return { startMs, endMs, days };
}

/** Validates a window (bounds, days and time zone) and returns it unchanged. */
export function assertTimeWindow(window: TimeWindow): TimeWindow {
  parseWindow(window);
  // Resolving any instant in the zone validates the zone name.
  toZoned(0, window.tz);
  return window;
}

function previousWeekday(weekday: IsoWeekday): IsoWeekday {
  return weekday === 1 ? SUNDAY : ((weekday - 1) as IsoWeekday);
}

/**
 * Whether instant `now` falls inside `window`, judged by the wall clock in `window.tz`. The host
 * time zone is never consulted. Invalid windows and zones throw `TimeValidationError`, so a caller
 * that gates traffic on this fails closed.
 *
 * **DST semantics.** An instant is inside when the local wall-clock reading at that instant is in
 * `[start, end)` on an allowed day. Consequences, all covered by tests:
 * - Spring forward (gap): wall times inside the gap never occur. A window `01:30-02:30` in New
 *   York on 2026-03-08 is open 01:30-01:59:59.999 EST, then closed, because the clock jumps to
 *   03:00 EDT; a window wholly inside the gap (`02:00-03:00`) does not open that day.
 * - Fall back (overlap): repeated wall times occur twice, so a window covering them is open during
 *   both occurrences. `01:00-02:00` in New York on 2026-11-01 is open for two real hours.
 * - A calendar day a zone skipped (Pacific/Apia, Friday 2011-12-30) has no wall-clock times, so a
 *   window that opens on it never opens. The after-midnight part of an overnight window is
 *   attributed by calendar to the previous date's weekday, even if that date was skipped.
 * - Leap seconds do not exist in ECMAScript time, so they never affect the result.
 */
export function isWithinWindow(now: Date | number, window: TimeWindow): boolean {
  const { startMs, endMs, days } = parseWindow(window);
  const local = toZoned(now, window.tz);
  const wallMs =
    local.hour * MS_PER_HOUR +
    local.minute * MS_PER_MINUTE +
    local.second * MS_PER_SECOND +
    local.millisecond;

  let openedOn: IsoWeekday;
  if (startMs < endMs) {
    if (wallMs < startMs || wallMs >= endMs) return false;
    openedOn = local.weekday;
  } else if (wallMs >= startMs) {
    openedOn = local.weekday;
  } else if (wallMs < endMs) {
    openedOn = previousWeekday(local.weekday);
  } else {
    return false;
  }
  return days === undefined || days.has(openedOn);
}
