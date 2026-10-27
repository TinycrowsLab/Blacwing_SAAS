import { TimeValidationError, zonedToUtc } from '@blackwing/time';
import { ValidationError } from '@blackwing/errors';

/** `YYYY-MM-DDTHH:mm[:ss[.fraction]]` with no `Z` and no offset: a wall-clock time. */
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const MILLIS_DIGITS = 3;

function invalid(field: string): ValidationError {
  return new ValidationError(`${field} is not a valid date-time`, {
    detail: `${field} is not a valid date-time`,
  });
}

/**
 * Reads one schedule boundary into a UTC instant. A value with `Z` or an offset is already an
 * instant. A wall-clock time is read in the roster's IANA zone (never the server's), so a rotation
 * that hands over at 09:00 local stays at 09:00 local across a DST change. A wall time that occurs
 * twice (clocks back) is the earlier one, and one that never occurs (clocks forward) moves forward by
 * the gap, the RFC 5545 rule.
 */
export function boundaryToInstant(value: string, timezone: string, field: string): Date {
  const wall = WALL_CLOCK.exec(value);
  if (wall === null) {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) throw invalid(field);
    return instant;
  }
  const [, year, month, day, hour, minute, second, fraction] = wall;
  try {
    return zonedToUtc(
      {
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second ?? 0),
        millisecond: Number(
          (fraction ?? '').padEnd(MILLIS_DIGITS, '0').slice(0, MILLIS_DIGITS) || 0,
        ),
      },
      timezone,
      { disambiguation: 'compatible' },
    );
  } catch (error) {
    if (error instanceof TimeValidationError) throw invalid(field);
    throw error;
  }
}
