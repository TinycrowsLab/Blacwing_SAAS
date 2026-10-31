import { CronExpressionParser } from 'cron-parser';

import { SCHEDULE_CRON_MAX } from '@blackwing/contracts';
import { AppError, InternalError, ValidationError } from '@blackwing/errors';
import { instantToMs, type LocalDateTime, toZoned, zonedToUtc } from '@blackwing/time';

/**
 * Recurring-run schedule time rules (SCHED-002, CONTEXT_PACK §7, §8.11). A schedule is a five-field cron expression
 * read as wall-clock time in an IANA zone. This module turns it into absolute UTC instants. It is pure: no IO, no host
 * time zone, and every instant is an explicit input.
 *
 * Cron is evaluated by cron-parser over a naive wall clock (plain UTC arithmetic on the wall-clock fields, which has no
 * DST). Each wall time it yields is then mapped to an instant in the schedule's zone with `@blackwing/time`, which is
 * built on luxon. The DST rules are decisive:
 * - A wall time that does not exist (spring-forward gap) is skipped: that day's fire does not happen, and the next fire
 *   is the next valid occurrence. It is not shifted to the gap's end.
 * - A wall time that occurs twice (fall-back overlap) fires once, at its first occurrence.
 */

/** A schedule expression has exactly five fields: minute, hour, day-of-month, month, day-of-week. */
const CRON_FIELD_COUNT = 5;
const MS_PER_MINUTE = 60_000;

/** Largest number of fires a preview may request (UI previews). */
export const SCHEDULE_PREVIEW_MAX = 20;

/** Longest window `isWithinWindow` accepts: one week. */
export const WINDOW_DURATION_MAX_MINUTES = 10_080;

/**
 * Shortcuts accepted in place of a five-field expression, expanded to that expression before anything else runs. Any
 * other `@name` (such as `@reboot`) is refused.
 */
const SHORTCUTS: ReadonlyMap<string, string> = new Map([
  ['@hourly', '0 * * * *'],
  ['@daily', '0 0 * * *'],
  ['@weekly', '0 0 * * 0'],
  ['@monthly', '0 0 1 * *'],
  ['@yearly', '0 0 1 1 *'],
]);

/**
 * IANA zone names the runtime lists, plus `UTC` (which `Intl.supportedValuesOf` omits). Membership is exact and
 * case-sensitive, so the host zone aliases (`local`, `system`) and fixed offsets (`+03:00`) are refused.
 */
const KNOWN_TIME_ZONES: ReadonlySet<string> = new Set([
  ...Intl.supportedValuesOf('timeZone'),
  'UTC',
]);

/** A validated schedule: the normalised cron expression and its zone. */
export interface ScheduleSpec {
  /** The five-field expression, with whitespace collapsed and any shortcut expanded. */
  readonly cronExpr: string;
  /** The IANA zone the wall-clock fields are read in. */
  readonly timezone: string;
  /**
   * True when the expression is valid but can never match, such as `0 0 30 2 *` (30 February). {@link nextFireAfter}
   * returns null for it, and {@link nextNFires} returns an empty list.
   */
  readonly neverFires: boolean;
}

/** Fixed epoch passed as cron-parser's `currentDate`, so nothing ever reads the host clock. */
const EPOCH = new Date(0);

/** cron-parser's refusal of an explicit day that a month never has (30 February). */
const IMPOSSIBLE_DAY_MESSAGE = 'Invalid explicit day of month definition';
/** cron-parser's refusal when a `next()` search finds no match within its own iteration limit. */
const LOOP_LIMIT_MESSAGE = 'Invalid expression, loop limit exceeded';
/** Upper bound on skipped wall times in one search. Only DST gaps and overlaps cause a skip. */
const MAX_WALL_CANDIDATES = 10_000;

function cronInvalid(): AppError {
  return new AppError('SCHEDULE_CRON_INVALID', 'schedule cron expression is invalid', {
    detail:
      'Use five fields (minute hour day-of-month month day-of-week), or one of @hourly, @daily, @weekly, @monthly, @yearly.',
  });
}

function timeZoneInvalid(): AppError {
  return new AppError('SCHEDULE_TZ_INVALID', 'schedule time zone is not an IANA zone', {
    detail: 'Use an IANA time zone name such as Europe/London or UTC.',
  });
}

function isCronParserError(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}

/** Collapses whitespace and expands a shortcut. Anything that is not a five-field expression is refused. */
function normaliseCron(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SCHEDULE_CRON_MAX) {
    throw cronInvalid();
  }
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.startsWith('@')) {
    const expanded = SHORTCUTS.get(text);
    if (expanded === undefined) throw cronInvalid();
    return expanded;
  }
  if (text.split(' ').length !== CRON_FIELD_COUNT) throw cronInvalid();
  return text;
}

interface CompiledSchedule {
  readonly spec: ScheduleSpec;
  /** How many minute values the expression lists. Used for the frequency rule. */
  readonly minuteCount: number;
}

/** Checks a cron expression and returns what it means, without applying the frequency rule. */
function compileSchedule(cronInput: unknown, timezoneInput: unknown): CompiledSchedule {
  const cronExpr = normaliseCron(cronInput);
  if (typeof timezoneInput !== 'string' || !KNOWN_TIME_ZONES.has(timezoneInput)) {
    throw timeZoneInvalid();
  }
  const timezone = timezoneInput;
  try {
    const parsed = CronExpressionParser.parse(cronExpr, { currentDate: EPOCH, tz: 'UTC' });
    return {
      spec: { cronExpr, timezone, neverFires: false },
      minuteCount: parsed.fields.minute.values.length,
    };
  } catch (error) {
    if (!isCronParserError(error, IMPOSSIBLE_DAY_MESSAGE)) throw cronInvalid();
  }
  // cron-parser refuses an explicit impossible day. The schedule is still valid, so the day-of-month field is replaced
  // by a wildcard to validate the other four fields, and the spec is marked as never firing.
  const [minute, hour, , month, dayOfWeek] = cronExpr.split(' ');
  try {
    const rest = CronExpressionParser.parse(`${minute} ${hour} * ${month} ${dayOfWeek}`, {
      currentDate: EPOCH,
      tz: 'UTC',
    });
    return {
      spec: { cronExpr, timezone, neverFires: true },
      minuteCount: rest.fields.minute.values.length,
    };
  } catch {
    throw cronInvalid();
  }
}

/**
 * Validates a schedule's cron expression and zone, and returns its spec. Throws `SCHEDULE_CRON_INVALID` for a bad
 * expression (including six fields, unknown shortcuts and `@reboot`) and `SCHEDULE_TZ_INVALID` for a zone that is not
 * an IANA name. It also refuses a schedule that fires more often than hourly (`SCHEDULE_TOO_FREQUENT`).
 *
 * Allowed shortcuts: `@hourly`, `@daily` (00:00), `@weekly` (Sunday 00:00), `@monthly` (day 1, 00:00) and `@yearly`
 * (1 January, 00:00). Each expands to the five-field form shown in `SHORTCUTS`.
 */
export function parseSchedule(input: {
  readonly cronExpr: string;
  readonly timezone: string;
}): ScheduleSpec {
  const { spec, minuteCount } = compileSchedule(input.cronExpr, input.timezone);
  // Every matching day fires every listed minute in every listed hour. Two minute values therefore fall less than 60
  // minutes apart in one hour, so the schedule is refused. A single minute gives gaps of at least 60 minutes, and
  // that holds across DST too: the spring-forward gap leaves a 60-minute step and the fall-back overlap fires once.
  if (minuteCount !== 1) {
    throw new AppError('SCHEDULE_TOO_FREQUENT', 'schedule fires more often than hourly', {
      detail:
        'A schedule may fire at most once an hour. Use a single minute value, such as 0 * * * *.',
    });
  }
  return spec;
}

/** Wall-clock fields of a naive UTC `Date` produced by cron-parser (its UTC fields are the wall time). */
function wallFieldsOf(wall: Date): LocalDateTime {
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
    millisecond: wall.getUTCMilliseconds(),
  };
}

/**
 * The first instant at which the wall clock in `timeZone` reads `wall`, or null when that wall time never occurs (a
 * spring-forward gap). The `earlier` policy resolves an overlap to its first occurrence, and in a gap it shifts the
 * time backwards. The read-back check then catches the gap, because a shifted time does not read as itself.
 */
function wallToInstant(wall: Date, timeZone: string): Date | null {
  const local = wallFieldsOf(wall);
  const instant = zonedToUtc(local, timeZone, { disambiguation: 'earlier' });
  const read = toZoned(instant, timeZone);
  const same =
    read.year === local.year &&
    read.month === local.month &&
    read.day === local.day &&
    read.hour === local.hour &&
    read.minute === local.minute &&
    read.second === local.second;
  return same ? instant : null;
}

/**
 * The next instant strictly after `fromUtc` at which the schedule fires, or null if it never fires (an impossible
 * expression, or one with no match within cron-parser's search limit). `fromUtc` is always treated as an absolute
 * instant. The host time zone is never read.
 */
export function nextFireAfter(spec: ScheduleSpec, fromUtc: Date): Date | null {
  const fromMs = instantToMs(fromUtc);
  if (spec.neverFires) return null;
  const from = toZoned(fromMs, spec.timezone);
  const wallStart = new Date(
    Date.UTC(
      from.year,
      from.month - 1,
      from.day,
      from.hour,
      from.minute,
      from.second,
      from.millisecond,
    ),
  );
  const cron = CronExpressionParser.parse(spec.cronExpr, { currentDate: wallStart, tz: 'UTC' });
  for (let candidates = 0; candidates < MAX_WALL_CANDIDATES; candidates += 1) {
    let wall: Date;
    try {
      wall = cron.next().toDate();
    } catch (error) {
      if (isCronParserError(error, LOOP_LIMIT_MESSAGE)) return null;
      throw error;
    }
    const instant = wallToInstant(wall, spec.timezone);
    if (instant !== null && instant.getTime() > fromMs) return instant;
  }
  throw new InternalError('schedule search did not converge');
}

/**
 * The next `n` fire instants after `fromUtc`, in order, for a UI preview. `n` must be an integer from 1 to
 * {@link SCHEDULE_PREVIEW_MAX}. A schedule that never fires yields an empty list.
 */
export function nextNFires(spec: ScheduleSpec, fromUtc: Date, n: number): Date[] {
  if (!Number.isInteger(n) || n < 1 || n > SCHEDULE_PREVIEW_MAX) {
    throw new ValidationError(`preview count must be an integer from 1 to ${SCHEDULE_PREVIEW_MAX}`);
  }
  const fires: Date[] = [];
  let cursor = fromUtc;
  while (fires.length < n) {
    const next = nextFireAfter(spec, cursor);
    if (next === null) break;
    fires.push(next);
    cursor = next;
  }
  return fires;
}

/**
 * Whether `atUtc` lies inside a window of `durationMinutes` that opens at a fire of `cronExpr` in `timezone`: a fire
 * `f` with `f <= atUtc < f + duration`. The window is half-open. Uses the same cron and zone validation as
 * {@link parseSchedule} but not its frequency rule, since a window bounds its own length. Throws `SCHEDULE_CRON_INVALID`
 * or `SCHEDULE_TZ_INVALID` for bad inputs, and `ValidationError` for a duration outside 1 to one week.
 */
export function isWithinWindow(
  cronExpr: string,
  timezone: string,
  durationMinutes: number,
  atUtc: Date,
): boolean {
  const { spec } = compileSchedule(cronExpr, timezone);
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 1 ||
    durationMinutes > WINDOW_DURATION_MAX_MINUTES
  ) {
    throw new ValidationError(
      `window duration must be an integer number of minutes from 1 to ${WINDOW_DURATION_MAX_MINUTES}`,
    );
  }
  const atMs = instantToMs(atUtc);
  const durationMs = durationMinutes * MS_PER_MINUTE;
  // The window opened at the latest fire in (at - duration, at]. The first fire after at - duration decides it.
  const opened = nextFireAfter(spec, new Date(atMs - durationMs));
  return opened !== null && opened.getTime() <= atMs;
}
