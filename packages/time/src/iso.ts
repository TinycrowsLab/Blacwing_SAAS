import { TimeValidationError } from './errors.js';

/**
 * A canonical Blackwing timestamp: ISO-8601 / RFC 3339 in UTC with millisecond precision,
 * `YYYY-MM-DDTHH:mm:ss.sssZ` (always 24 characters, always `Z`). Every formatter in this package
 * returns this shape and nothing else, so two timestamps compare correctly as plain strings.
 */
export type IsoTimestamp = string & { readonly __brand: 'IsoTimestamp' };

/** Which textual forms {@link fromIso} accepts. */
export type IsoParseMode =
  /** Only the canonical `YYYY-MM-DDTHH:mm:ss.sssZ` form (the default). */
  | 'canonical'
  /**
   * Any RFC 3339 date-time with an explicit `Z` or `±HH:MM` offset and 0 to 9 fractional digits. The
   * instant is normalised to UTC; fractional digits after the third are truncated (never rounded).
   */
  | 'rfc3339';

/** Options for {@link fromIso}. */
export interface FromIsoOptions {
  readonly accept?: IsoParseMode;
}

/** Earliest instant with a four-digit year: `0000-01-01T00:00:00.000Z`. */
export const MIN_ISO_MS = -62_167_219_200_000;
/** Latest instant with a four-digit year: `9999-12-31T23:59:59.999Z`. */
export const MAX_ISO_MS = 253_402_300_799_999;

/** Longest text either parser looks at (`9999-12-31T23:59:59.123456789+00:00` is 35 characters). */
const MAX_INPUT_LENGTH = 64;

const CANONICAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))?$/;

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MAX_YEAR = 9999;
const MONTHS_PER_YEAR = 12;
const MAX_HOUR = 23;
const MAX_MINUTE = 59;
const MAX_SECOND = 59;
/** Second 60 exists only in UTC leap seconds, which ECMAScript time cannot represent. */
const LEAP_SECOND = 60;
const MAX_MILLISECOND = 999;
/** Fractional digits kept: milliseconds. */
const MS_DIGITS = 3;

/** Whether a value is a `Date` (also one from another realm, or a subclass). */
function isDate(value: unknown): value is Date {
  return value instanceof Date || Object.prototype.toString.call(value) === '[object Date]';
}

/**
 * The epoch-millisecond value of an instant given as a `Date` or a number. Rejects invalid dates,
 * non-finite numbers and anything outside the four-digit-year range.
 */
export function instantToMs(value: Date | number): number {
  let ms: number;
  if (isDate(value)) {
    // Read the internal time value directly: an overridden `getTime` on the instance cannot lie.
    ms = Date.prototype.getTime.call(value);
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TimeValidationError(
        'invalid_date',
        'instant must be a finite number of milliseconds',
      );
    ms = new Date(value).getTime();
  } else {
    throw new TimeValidationError(
      'invalid_type',
      'instant must be a Date or a number of milliseconds',
    );
  }
  if (Number.isNaN(ms)) throw new TimeValidationError('invalid_date', 'instant is an invalid Date');
  if (ms < MIN_ISO_MS || ms > MAX_ISO_MS) {
    throw new TimeValidationError('year_out_of_range', 'instant is outside years 0000-9999');
  }
  return ms;
}

/**
 * Formats an instant as a canonical {@link IsoTimestamp} (`2026-03-08T07:00:00.000Z`). The host time
 * zone plays no part. Throws `TimeValidationError` for an invalid `Date`, a non-finite number or a
 * year outside 0000-9999 (which `Date#toISOString` would write in the six-digit expanded form).
 */
export function toIso(value: Date | number): IsoTimestamp {
  return new Date(instantToMs(value)).toISOString() as IsoTimestamp;
}

/** Whether `value` is a string in the canonical {@link IsoTimestamp} form and names a real instant. */
export function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== 'string') return false;
  try {
    fromIso(value);
    return true;
  } catch {
    return false;
  }
}

/** Days in `month` (1-12) of proleptic Gregorian `year`: day 0 of the next month is its last day. */
function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/** Calendar and clock fields; `second` may not be 60. Throws `out_of_range` / `leap_second`. */
export interface CivilFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/**
 * Validates civil fields and returns the epoch milliseconds they denote when read as UTC.
 * Shared by the ISO parser and the zone helpers so both reject the same things.
 */
export function civilToUtcMs(fields: CivilFields): number {
  const { year, month, day, hour, minute, second, millisecond } = fields;
  for (const value of [year, month, day, hour, minute, second, millisecond]) {
    if (!Number.isInteger(value))
      throw new TimeValidationError('invalid_type', 'date-time fields must be integers');
  }
  if (year < 0 || year > MAX_YEAR)
    throw new TimeValidationError('year_out_of_range', 'year must be 0000-9999');
  if (month < 1 || month > MONTHS_PER_YEAR)
    throw new TimeValidationError('out_of_range', 'month must be 01-12');
  if (day < 1 || day > daysInMonth(year, month))
    throw new TimeValidationError('out_of_range', 'day is not in the month');
  if (hour < 0 || hour > MAX_HOUR)
    throw new TimeValidationError('out_of_range', 'hour must be 00-23');
  if (minute < 0 || minute > MAX_MINUTE)
    throw new TimeValidationError('out_of_range', 'minute must be 00-59');
  if (second === LEAP_SECOND) {
    throw new TimeValidationError('leap_second', 'leap seconds (second 60) are not representable');
  }
  if (second < 0 || second > MAX_SECOND)
    throw new TimeValidationError('out_of_range', 'second must be 00-59');
  if (millisecond < 0 || millisecond > MAX_MILLISECOND)
    throw new TimeValidationError('out_of_range', 'millisecond must be 000-999');
  // `Date.UTC` maps years 0-99 to 1900-1999; `setUTCFullYear` does not.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

function int(text: string | undefined): number {
  return Number.parseInt(text ?? '0', 10);
}

/**
 * Parses an ISO-8601 UTC timestamp into a new `Date`.
 *
 * - `accept: "canonical"` (default): exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, so
 *   `toIso(fromIso(s)) === s` for every accepted `s`.
 * - `accept: "rfc3339"`: any RFC 3339 date-time with `Z`/`z` or a `±HH:MM` offset, `T` or `t`,
 *   and 0 to 9 fractional digits; the result is the same instant in UTC (sub-millisecond digits are
 *   truncated). Use it at boundaries that receive timestamps from third parties, then store
 *   {@link toIso} of the result.
 *
 * Both modes reject, with a `TimeValidationError`: non-strings; a date-time with no offset
 * (`missing_offset`: it would only mean something in the host time zone, which is never consulted);
 * a non-`Z` offset in canonical mode (`not_utc`); impossible fields such as 30 February or 24:00
 * (`out_of_range`); second 60 (`leap_second`); and instants outside years 0000-9999. Date-only
 * strings, week dates, ordinal dates, a space separator and basic (no-hyphen) formats are malformed.
 */
export function fromIso(text: string, options: FromIsoOptions = {}): Date {
  if (typeof text !== 'string')
    throw new TimeValidationError('invalid_type', 'timestamp must be a string');
  const mode = options.accept ?? 'canonical';
  if (text.length > MAX_INPUT_LENGTH)
    throw new TimeValidationError('malformed', 'timestamp is too long');

  if (mode === 'canonical') {
    const match = CANONICAL.exec(text);
    if (match === null) {
      const loose = RFC3339.exec(text);
      if (loose !== null && loose[8] === undefined && loose[9] === undefined) {
        throw new TimeValidationError(
          'missing_offset',
          'timestamp has no UTC designator; expected YYYY-MM-DDTHH:mm:ss.sssZ',
        );
      }
      if (loose?.[9] !== undefined) {
        throw new TimeValidationError(
          'not_utc',
          'timestamp must be in UTC (Z); expected YYYY-MM-DDTHH:mm:ss.sssZ',
        );
      }
      throw new TimeValidationError('malformed', 'timestamp must be YYYY-MM-DDTHH:mm:ss.sssZ');
    }
    return new Date(
      civilToUtcMs({
        year: int(match[1]),
        month: int(match[2]),
        day: int(match[3]),
        hour: int(match[4]),
        minute: int(match[5]),
        second: int(match[6]),
        millisecond: int(match[7]),
      }),
    );
  }

  const match = RFC3339.exec(text);
  if (match === null)
    throw new TimeValidationError('malformed', 'timestamp must be an RFC 3339 date-time');
  if (match[8] === undefined && match[9] === undefined) {
    throw new TimeValidationError('missing_offset', 'timestamp has no UTC designator or offset');
  }
  const fraction = match[7] ?? '';
  const local = civilToUtcMs({
    year: int(match[1]),
    month: int(match[2]),
    day: int(match[3]),
    hour: int(match[4]),
    minute: int(match[5]),
    second: int(match[6]),
    millisecond: int(fraction.padEnd(MS_DIGITS, '0').slice(0, MS_DIGITS)),
  });
  let offsetMinutes = 0;
  if (match[9] !== undefined) {
    const offsetHour = int(match[10]);
    const offsetMinute = int(match[11]);
    if (offsetHour > MAX_HOUR || offsetMinute > MAX_MINUTE)
      throw new TimeValidationError('out_of_range', 'offset must be -23:59 to +23:59');
    offsetMinutes = (match[9] === '-' ? -1 : 1) * (offsetHour * MINUTES_PER_HOUR + offsetMinute);
  }
  const ms = local - offsetMinutes * MS_PER_MINUTE;
  if (ms < MIN_ISO_MS || ms > MAX_ISO_MS) {
    throw new TimeValidationError(
      'year_out_of_range',
      'timestamp in UTC is outside years 0000-9999',
    );
  }
  return new Date(ms);
}

/**
 * Normalises any RFC 3339 date-time with an explicit offset to the canonical UTC form:
 * `normalizeIso("2026-03-08T02:30:00-05:00") === "2026-03-08T07:30:00.000Z"`.
 */
export function normalizeIso(text: string): IsoTimestamp {
  return toIso(fromIso(text, { accept: 'rfc3339' }));
}
