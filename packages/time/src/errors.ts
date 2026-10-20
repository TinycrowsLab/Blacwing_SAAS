import { ValidationError } from '@blackwing/errors';

/**
 * Why a timestamp, duration, time zone or window was rejected. Stable machine keys: callers and
 * tests match on these, never on the human-readable message.
 */
export type TimeValidationReason =
  /** The value is not of the expected type (a string, a `Date`, a number, an object). */
  | 'invalid_type'
  /** The text does not have the expected shape at all. */
  | 'malformed'
  /** A date-time without a UTC designator or offset: it would only mean something in a host time zone. */
  | 'missing_offset'
  /** Strict parsing was asked for and the text carries an offset other than `Z`. */
  | 'not_utc'
  /** A calendar or clock field is out of range (month 13, 30 February, 25:00, offset +24:00). */
  | 'out_of_range'
  /** Second `60`. Leap seconds are not representable in ECMAScript time (POSIX time). */
  | 'leap_second'
  /** A `Date` whose time value is `NaN`, or a non-finite number. */
  | 'invalid_date'
  /** The instant cannot be written as a four-digit-year ISO-8601 string (before 0000 or after 9999). */
  | 'year_out_of_range'
  /** A duration string that is not `<digits><unit>`. */
  | 'invalid_duration'
  /** A negative duration (`-1s`, or a negative millisecond count). */
  | 'negative_duration'
  /** A duration unit outside `ms`, `s`, `m`, `h`, `d` (units are case-sensitive). */
  | 'unknown_unit'
  /** The duration does not fit in a safe integer number of milliseconds. */
  | 'duration_overflow'
  /** Not an IANA time-zone name (this includes `local`, `system` and fixed-offset specifiers). */
  | 'invalid_time_zone'
  /** A wall-clock time that is not `HH:mm` or `HH:mm:ss` in range. */
  | 'invalid_time_of_day'
  /** A window whose bounds or day list cannot describe a non-empty window. */
  | 'invalid_window'
  /** The local date-time falls in a DST gap and `disambiguation: "reject"` was asked for. */
  | 'nonexistent_local_time'
  /** The local date-time occurs twice (DST overlap) and `disambiguation: "reject"` was asked for. */
  | 'ambiguous_local_time';

/**
 * Raised for every invalid time input.
 *
 * A `ValidationError` from `@blackwing/errors`: code `VALIDATION_FAILED`, HTTP 422, not retryable.
 * The message never echoes the rejected value (it may come from untrusted input), which is why it is
 * also safe to use as the client-facing `detail`.
 */
export class TimeValidationError extends ValidationError {
  /** Machine-readable reason for the rejection. */
  readonly reason: TimeValidationReason;

  constructor(reason: TimeValidationReason, message: string) {
    super(message, { detail: message });
    this.name = 'ValidationError';
    this.reason = reason;
  }
}

/** Type guard for {@link TimeValidationError}. */
export function isTimeValidationError(value: unknown): value is TimeValidationError {
  return value instanceof TimeValidationError;
}
