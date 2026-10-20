/** Workspace package name of this package. */
export const name = '@blackwing/time';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  type Clock,
  Deadline,
  FixedClock,
  type InstantInput,
  nowIso,
  nowUtc,
  SystemClock,
  systemClock,
  toInstantMs,
} from './clock.js';
export {
  addDuration,
  assertDurationMs,
  DURATION_UNITS,
  type DurationInput,
  type DurationString,
  type DurationUnit,
  formatDuration,
  parseDuration,
  toDurationMs,
} from './duration.js';
export { isTimeValidationError, TimeValidationError, type TimeValidationReason } from './errors.js';
export {
  type FromIsoOptions,
  fromIso,
  instantToMs,
  isIsoTimestamp,
  type IsoParseMode,
  type IsoTimestamp,
  MAX_ISO_MS,
  MIN_ISO_MS,
  normalizeIso,
  toIso,
} from './iso.js';
export {
  assertTimeWindow,
  isWithinWindow,
  parseTimeOfDay,
  type ParseTimeOfDayOptions,
  type TimeWindow,
} from './window.js';
export {
  assertTimeZone,
  type Disambiguation,
  isIsoWeekday,
  isValidTimeZone,
  type IsoWeekday,
  type LocalDateTime,
  PINNED_LUXON_VERSION,
  timeZoneRuntime,
  type TimeZoneRuntime,
  toZoned,
  type ZonedDateTimeParts,
  zonedToUtc,
  type ZonedToUtcOptions,
} from './zone.js';
