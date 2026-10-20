# @blackwing/time

ISO-8601 UTC timestamps, durations, an injectable `Clock`, and time-zone primitives that are safe
across DST changes (CONTEXT_PACK §5: "Dates are ISO-8601 UTC"). Every package that formats, parses or
reads the current time uses this one. Nothing here reads the host time zone.

```ts
import {
  type Clock,
  Deadline,
  FixedClock,
  formatDuration,
  fromIso,
  isWithinWindow,
  normalizeIso,
  parseDuration,
  systemClock,
  toIso,
} from '@blackwing/time';

toIso(new Date()); // "2026-03-08T07:00:00.000Z" (IsoTimestamp)
fromIso('2026-03-08T07:00:00.000Z'); // Date; only the canonical form
normalizeIso('2026-03-08T02:00:00-05:00'); // "2026-03-08T07:00:00.000Z": third-party input
parseDuration('5m'); // 300000
formatDuration(300_000); // "5m"

class GateService {
  constructor(private readonly clock: Clock = systemClock) {}
  open(timeout: string) {
    return Deadline.after(timeout, this.clock);
  } // isExpired(), remainingMs()
}
const clock = new FixedClock('2026-03-08T06:00:00.000Z'); // tests: time moves only on advance()/set()

isWithinWindow(clock.now(), {
  tz: 'Europe/London',
  start: '22:00',
  end: '06:00',
  days: [1, 2, 3, 4, 5],
});
```

## Timestamps

`toIso` always writes `YYYY-MM-DDTHH:mm:ss.sssZ`: 24 characters, millisecond precision, `Z`. Those
strings sort the same way as the instants they name. `fromIso` accepts only that form by default, so
`toIso(fromIso(s)) === s` for every accepted `s` (a fast-check property test).

| Input                                                                     | `fromIso(s)`        | `fromIso(s, { accept: "rfc3339" })` / `normalizeIso(s)` |
| ------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------- |
| `2026-03-08T07:00:00.000Z`                                                | accepted            | accepted                                                |
| `2026-03-08T07:00:00Z`, `.5Z`, `.123456789Z`, lowercase `t`/`z`           | `malformed`         | accepted; digits after the 3rd are truncated            |
| `2026-03-08T02:00:00-05:00`                                               | `not_utc`           | normalised to `2026-03-08T07:00:00.000Z`                |
| `2026-03-08T02:00:00` (no offset)                                         | `missing_offset`    | `missing_offset` (never read in the host zone)          |
| `2026-02-30…`, `24:00`, offset `+24:00`                                   | `out_of_range`      | `out_of_range`                                          |
| `…23:59:60…`                                                              | `leap_second`       | `leap_second`                                           |
| date only, space separator, week/ordinal dates, basic format, `+002026-…` | `malformed`         | `malformed`                                             |
| an instant outside years 0000-9999                                        | `year_out_of_range` | `year_out_of_range`                                     |

**Leap seconds are not represented.** ECMAScript time is POSIX time: every day has 86 400 seconds,
and the clock steps or smears over a leap second (whatever the host's NTP does). Second `60` is
rejected wherever it appears, and nothing in this package can produce it.

## Durations

`parseDuration` takes one unsigned integer and one unit out of `ms`, `s`, `m`, `h`, `d`, and returns
milliseconds. Units are case-sensitive (`5M` is rejected, not read as minutes or months). Signs,
fractions, exponents, spaces and compound forms (`1h30m`) are rejected. A day is always 86 400 000 ms.
Durations are elapsed time, so `addDuration(t, "1d")` across a DST change is 24 real hours.
`formatDuration` picks the largest exact unit (`90000` is `"90s"`, `0` is `"0s"`), and
`parseDuration(formatDuration(n)) === n` (property test). Rejections: `negative_duration`, `unknown_unit`,
`duration_overflow` (beyond `Number.MAX_SAFE_INTEGER` ms) and `invalid_duration` (`NaN`, `1.5h`, `300`).

## Clock

`Clock` has `now()`, `nowMs()` and `monotonicMs()` (for elapsed time such as kill-switch halt time,
§8.5). Time-dependent code takes a `Clock` in its constructor and never calls `Date.now()`.
`systemClock` is the real one. `FixedClock` moves only when a test calls `advance(duration)` (wall
and monotonic time together) or `set(instant)` (a wall-clock step, forwards or backwards; monotonic
time is unchanged). `nowUtc(clock)` and `nowIso(clock)` read it.

`Deadline` is an expiry (a gate timeout, an envelope or SA `expires_at`) read through the injected
clock. **Expiry is inclusive**: at exactly `expiresAt` it has expired. A clock that returns `NaN`
counts as expired. Both rules fail closed (§8.1).

## Time zones and windows

Zones must be IANA names (`Europe/London`, `America/Argentina/Buenos_Aires`, `UTC`, `Etc/GMT+3`).
`local`, `system`, `default`, `UTC+3` and `+03:00` are rejected (`invalid_time_zone`), so nothing can
fall back to the server's zone. `toZoned(instant, tz)` gives the wall-clock reading, offset and ISO
weekday. `zonedToUtc(local, tz, { disambiguation })` goes the other way and follows the Temporal
proposal's policies:

| Policy                              | Overlap (fall back: the time occurs twice) | Gap (spring forward: the time never occurs)    |
| ----------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| `compatible` (default, as RFC 5545) | earlier instant                            | moved forward by the gap (02:30 becomes 03:30) |
| `earlier`                           | earlier instant                            | moved back by the gap (02:30 becomes 01:30)    |
| `later`                             | later instant                              | moved forward by the gap                       |
| `reject`                            | `ambiguous_local_time`                     | `nonexistent_local_time`                       |

`isWithinWindow(now, { tz, start, end, days? })` checks whether an instant is in a daily wall-clock
window. `start`/`end` are `HH:mm[:ss]`, and the window is half-open, `[start, end)`. `end` may be
`24:00`. If `end` is earlier than `start`, the window crosses midnight. `days` holds ISO weekdays
(1 = Monday) on which the window **opens**, and the part after midnight belongs to the opening day.
An instant is inside when its **wall-clock reading** in `tz` is inside. So:

- **Spring forward:** times in the gap never occur. In New York on 2026-03-08, `01:30-02:30` is open
  for 30 real minutes and `02:00-03:00` does not open at all.
- **Fall back:** repeated times occur twice, so a window that covers them is open both times. In New
  York on 2026-11-01, `01:00-02:00` is open for two real hours.
- Midnight transitions (America/Havana), 30-minute shifts (Australia/Lord_Howe), the southern
  hemisphere (Australia/Sydney) and Samoa's skipped day (Pacific/Apia, 2011-12-30) are all tested.

Invalid windows, zones or instants throw `TimeValidationError`. A caller that gates traffic on the
result therefore fails closed. Evaluating cron expressions belongs to the standing-authorisation and
scheduler epics. They build on these primitives.

## Version pinning and tz data

Luxon is pinned exactly (`3.7.2`, asserted by a test). Luxon reads zone rules from the runtime's ICU
through `Intl`, so the tz database version is Node's `process.versions.tz`. It changes only when the
pinned Node version (`.nvmrc`) changes. `timeZoneRuntime()` reports both versions, for the per-run
pinned-version record (§8.9). Updating tz data means bumping Node, then rerunning the DST tests.

## Errors

Every rejection is a `TimeValidationError`, a `ValidationError` from `@blackwing/errors`
(`VALIDATION_FAILED`, HTTP 422, not retryable) with a machine-readable `reason`. Messages never echo
the rejected input.
