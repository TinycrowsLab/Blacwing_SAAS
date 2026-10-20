import { DateTime, IANAZone, VERSION as LUXON_VERSION } from 'luxon';

import { TimeValidationError } from './errors.js';
import { civilToUtcMs, instantToMs } from './iso.js';

/** ISO weekday: 1 is Monday, 7 is Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** What an instant reads on the wall clock in a time zone. */
export interface ZonedDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  readonly weekday: IsoWeekday;
  /** UTC offset in minutes at that instant (`-240` for New York in summer, `330` for Kolkata). */
  readonly offsetMinutes: number;
}

/** A wall-clock date-time with no zone attached. `second` and `millisecond` default to 0. */
export interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second?: number;
  readonly millisecond?: number;
}

/**
 * How {@link zonedToUtc} picks an instant when a wall-clock time is not unique. The names and
 * behaviour match the TC39 Temporal proposal (and RFC 5545 for `compatible`):
 *
 * | Policy | DST overlap (time occurs twice) | DST gap (time never occurs) |
 * |---|---|---|
 * | `compatible` (default) | the earlier instant | shifted forward by the gap length (02:30 becomes 03:30) |
 * | `earlier` | the earlier instant | shifted backward by the gap length (02:30 becomes 01:30) |
 * | `later` | the later instant | shifted forward by the gap length |
 * | `reject` | throws `ambiguous_local_time` | throws `nonexistent_local_time` |
 */
export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject';

/** Options for {@link zonedToUtc}. */
export interface ZonedToUtcOptions {
  readonly disambiguation?: Disambiguation;
}

/**
 * The time-zone library and the tz database actually in use, for pinned-version records (§8.9).
 * Luxon reads zone rules from the runtime's ICU (`Intl`), so the database version is Node's
 * `process.versions.tz`. `.nvmrc` pins only the Node major, and Node minor releases can ship newer
 * tz data, so record the version reported here rather than assuming one.
 */
export interface TimeZoneRuntime {
  readonly library: 'luxon';
  readonly libraryVersion: string;
  readonly tzdataVersion: string;
}

/** Luxon version this package is built and tested against (pinned exactly in package.json). */
export const PINNED_LUXON_VERSION = '3.7.2';

/** Reports the tz library and tz database versions. */
export function timeZoneRuntime(): TimeZoneRuntime {
  return {
    library: 'luxon',
    libraryVersion: LUXON_VERSION,
    tzdataVersion: process.versions.tz ?? 'unknown',
  };
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MAX_ZONE_LENGTH = 64;
/**
 * IANA names (`Europe/London`, `America/Argentina/Buenos_Aires`, `Etc/GMT+3`, `UTC`, `EST5EDT`).
 * The leading letter excludes the ECMA-402 offset zones (`+03:00`) that `Intl` also accepts.
 */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
/** Names Luxon would map to the host zone. They must never reach Luxon as a zone. */
const HOST_ZONE_ALIASES = new Set(['local', 'system', 'default']);

/** The tz database has about 600 names; this leaves room for aliases and spelling variants. */
const MAX_CACHED_ZONES = 1024;
const zoneCache = new Map<string, IANAZone>();

/**
 * Whether `value` is an IANA time-zone name the runtime knows. The host-zone aliases `local`,
 * `system` and `default`, fixed-offset specifiers (`UTC+3`, `+03:00`) and empty or oversized strings
 * are rejected, so nothing in this package can silently fall back to the server's time zone.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ZONE_LENGTH)
    return false;
  if (!IANA_NAME.test(value) || HOST_ZONE_ALIASES.has(value.toLowerCase())) return false;
  return IANAZone.isValidZone(value);
}

function zoneOf(tz: string): IANAZone {
  const cached = zoneCache.get(tz);
  if (cached !== undefined) return cached;
  if (!isValidTimeZone(tz))
    throw new TimeValidationError(
      'invalid_time_zone',
      'time zone must be an IANA name such as Europe/London',
    );
  // Zone names are case-insensitive and may arrive from tenants, so Luxon (whose own cache is
  // unbounded) only ever sees the runtime's canonical spelling, and our cache is bounded.
  const canonical = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  const zone = IANAZone.create(canonical);
  if (!zone.isValid)
    throw new TimeValidationError(
      'invalid_time_zone',
      'time zone must be an IANA name such as Europe/London',
    );
  if (zoneCache.size >= MAX_CACHED_ZONES) zoneCache.clear();
  zoneCache.set(tz, zone);
  return zone;
}

/** Throws `invalid_time_zone` unless `value` passes {@link isValidTimeZone}; returns it otherwise. */
export function assertTimeZone(value: unknown): string {
  if (typeof value !== 'string')
    throw new TimeValidationError(
      'invalid_time_zone',
      'time zone must be an IANA name such as Europe/London',
    );
  zoneOf(value);
  return value;
}

/** UTC offset in minutes of `tz` at epoch milliseconds `ms`. */
function offsetAt(zone: IANAZone, ms: number): number {
  return zone.offset(ms);
}

/** Highest ISO weekday (Sunday). */
const SUNDAY = 7;

/** Whether `value` is an ISO weekday, 1 (Monday) to 7 (Sunday). */
export function isIsoWeekday(value: unknown): value is IsoWeekday {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= SUNDAY;
}

function asIsoWeekday(value: number): IsoWeekday {
  if (isIsoWeekday(value)) return value;
  // Luxon always yields 1-7 for a valid DateTime; anything else means the zone could not be read.
  throw new TimeValidationError('invalid_time_zone', 'time zone could not be evaluated');
}

/**
 * What `instant` reads on the wall clock in IANA zone `tz`. The host time zone and Luxon's
 * `Settings.defaultZone` are never consulted.
 */
export function toZoned(instant: Date | number, tz: string): ZonedDateTimeParts {
  const ms = instantToMs(instant);
  const dt = DateTime.fromMillis(ms, { zone: zoneOf(tz) });
  return {
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
    second: dt.second,
    millisecond: dt.millisecond,
    weekday: asIsoWeekday(dt.weekday),
    offsetMinutes: dt.offset,
  };
}

/**
 * The instant at which the wall clock in IANA zone `tz` reads `local`, resolving DST gaps and
 * overlaps with an explicit {@link Disambiguation} policy (default `compatible`). Throws
 * `TimeValidationError` for invalid fields (30 February, 24:00, second 60), an invalid zone, or a
 * gap/overlap under `reject`.
 *
 * Candidate offsets are taken one day either side of the wall time, which covers every real zone
 * (no zone changes its offset twice within 48 hours).
 */
export function zonedToUtc(
  local: LocalDateTime,
  tz: string,
  options: ZonedToUtcOptions = {},
): Date {
  const zone = zoneOf(tz);
  const disambiguation = options.disambiguation ?? 'compatible';
  const wallMs = civilToUtcMs({
    year: local.year,
    month: local.month,
    day: local.day,
    hour: local.hour,
    minute: local.minute,
    second: local.second ?? 0,
    millisecond: local.millisecond ?? 0,
  });
  const offsetBefore = offsetAt(zone, wallMs - MS_PER_DAY);
  const offsetAfter = offsetAt(zone, wallMs + MS_PER_DAY);
  const candidates = [
    ...new Set([wallMs - offsetBefore * MS_PER_MINUTE, wallMs - offsetAfter * MS_PER_MINUTE]),
  ]
    .filter((ms) => ms + offsetAt(zone, ms) * MS_PER_MINUTE === wallMs)
    .sort((a, b) => a - b);

  const [first, second] = candidates;
  let resolved: number;
  if (first !== undefined && second === undefined) {
    resolved = first;
  } else if (first !== undefined && second !== undefined) {
    if (disambiguation === 'reject') {
      throw new TimeValidationError(
        'ambiguous_local_time',
        'local time occurs twice in this time zone (DST overlap)',
      );
    }
    resolved = disambiguation === 'later' ? second : first;
  } else {
    if (disambiguation === 'reject') {
      throw new TimeValidationError(
        'nonexistent_local_time',
        'local time does not exist in this time zone (DST gap)',
      );
    }
    // In a gap, reading the wall time with the pre-transition offset lands after the gap
    // (shifted forward); with the post-transition offset it lands before it (shifted backward).
    resolved =
      disambiguation === 'earlier'
        ? wallMs - offsetAfter * MS_PER_MINUTE
        : wallMs - offsetBefore * MS_PER_MINUTE;
  }
  return new Date(instantToMs(resolved));
}
