import { TimeValidationError } from './errors.js';
import { instantToMs } from './iso.js';

/** Milliseconds per duration unit. Units are lowercase and case-sensitive (`5M` is not five minutes). */
export const DURATION_UNITS = Object.freeze({
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const);

/** A duration unit: `ms`, `s`, `m`, `h` or `d`. */
export type DurationUnit = keyof typeof DURATION_UNITS;

/** The textual form {@link parseDuration} accepts: an unsigned integer followed by one unit (`"30s"`). */
export type DurationString = `${number}${DurationUnit}`;

/** A duration given either as milliseconds or as a {@link DurationString}. */
export type DurationInput = number | string;

/** Largest units first, for {@link formatDuration}. */
const UNITS_DESCENDING: readonly DurationUnit[] = ['d', 'h', 'm', 's', 'ms'];

const MAX_INPUT_LENGTH = 32;
const DURATION = /^(\d+)(ms|s|m|h|d)$/;
const SIGNED_NUMBER_WITH_SUFFIX = /^-\d+(?:\.\d+)?[A-Za-z]*$/;
const DIGITS_WITH_WORD = /^\d+([A-Za-z]+)$/;

function isUnit(value: string): value is DurationUnit {
  return Object.hasOwn(DURATION_UNITS, value);
}

/**
 * Parses a duration such as `"30s"`, `"5m"`, `"2h"`, `"7d"` or `"250ms"` into milliseconds.
 *
 * The grammar is deliberately small: one unsigned decimal integer, then exactly one unit from
 * `ms, s, m, h, d`, with no sign, spaces, fractions, exponent or compound forms (`1h30m`). A day is
 * always 86 400 000 ms: durations are elapsed time, not calendar arithmetic, so a `1d` timer that
 * spans a DST change is 24 real hours. Throws `TimeValidationError` with reason `negative_duration`
 * (`-1s`), `unknown_unit` (`5M`, `5w`), `duration_overflow` (beyond `Number.MAX_SAFE_INTEGER` ms),
 * `invalid_duration` (`NaN`, `1.5h`, `300`, `""`) or `invalid_type`.
 */
export function parseDuration(text: string): number {
  if (typeof text !== 'string')
    throw new TimeValidationError('invalid_type', 'duration must be a string');
  if (text.length > MAX_INPUT_LENGTH)
    throw new TimeValidationError('invalid_duration', 'duration is too long');
  const match = DURATION.exec(text);
  if (match === null) {
    if (SIGNED_NUMBER_WITH_SUFFIX.test(text))
      throw new TimeValidationError('negative_duration', 'duration must not be negative');
    const word = DIGITS_WITH_WORD.exec(text);
    if (word !== null)
      throw new TimeValidationError('unknown_unit', 'duration unit must be one of ms, s, m, h, d');
    throw new TimeValidationError(
      'invalid_duration',
      'duration must be an unsigned integer followed by ms, s, m, h or d',
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  if (!isUnit(unit))
    throw new TimeValidationError('unknown_unit', 'duration unit must be one of ms, s, m, h, d');
  const ms = amount * DURATION_UNITS[unit];
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(ms)) {
    throw new TimeValidationError('duration_overflow', 'duration is too large');
  }
  return ms;
}

/**
 * Checks a millisecond duration: a non-negative safe integer. Returns it unchanged. Rejects `NaN`,
 * infinities and fractions (`invalid_duration`) and negatives (`negative_duration`).
 */
export function assertDurationMs(ms: number): number {
  if (typeof ms !== 'number')
    throw new TimeValidationError('invalid_type', 'duration must be a number of milliseconds');
  if (!Number.isFinite(ms) || !Number.isInteger(ms)) {
    throw new TimeValidationError(
      'invalid_duration',
      'duration must be a whole number of milliseconds',
    );
  }
  if (ms < 0) throw new TimeValidationError('negative_duration', 'duration must not be negative');
  if (!Number.isSafeInteger(ms))
    throw new TimeValidationError('duration_overflow', 'duration is too large');
  return ms;
}

/** Milliseconds from either a millisecond count or a duration string. */
export function toDurationMs(value: DurationInput): number {
  return typeof value === 'string' ? parseDuration(value) : assertDurationMs(value);
}

/**
 * Formats milliseconds with the largest unit that represents them exactly: `300000` is `"5m"`,
 * `90000` is `"90s"`, `1500` is `"1500ms"`, `0` is `"0s"`. `parseDuration(formatDuration(n)) === n`
 * for every valid `n`. Throws like {@link assertDurationMs}.
 */
export function formatDuration(ms: number): DurationString {
  assertDurationMs(ms);
  if (ms === 0) return '0s';
  // Every integer divides by 1, so the search always ends at `ms` at the latest.
  const unit = UNITS_DESCENDING.find((candidate) => ms % DURATION_UNITS[candidate] === 0) ?? 'ms';
  return `${ms / DURATION_UNITS[unit]}${unit}`;
}

/**
 * The instant `duration` after `instant`, as a new `Date` (elapsed time, so DST never shifts it).
 * Throws when the instant is invalid, the duration is invalid or negative, or the result leaves
 * years 0000-9999.
 */
export function addDuration(instant: Date | number, duration: DurationInput): Date {
  return new Date(instantToMs(instantToMs(instant) + toDurationMs(duration)));
}
