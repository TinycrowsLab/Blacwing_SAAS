import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as time from './index.js';

describe('@blackwing/time public surface', () => {
  it('names itself and matches package.json', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name: string; version: string };
    expect(time.name).toBe(manifest.name);
    expect(time.version).toBe(manifest.version);
  });

  it('exports the documented API', () => {
    const expected = [
      'addDuration',
      'assertDurationMs',
      'assertTimeWindow',
      'assertTimeZone',
      'Deadline',
      'DURATION_UNITS',
      'FixedClock',
      'formatDuration',
      'fromIso',
      'instantToMs',
      'isIsoTimestamp',
      'isIsoWeekday',
      'isTimeValidationError',
      'isValidTimeZone',
      'isWithinWindow',
      'MAX_ISO_MS',
      'MIN_ISO_MS',
      'name',
      'normalizeIso',
      'nowIso',
      'nowUtc',
      'parseDuration',
      'parseTimeOfDay',
      'PINNED_LUXON_VERSION',
      'SystemClock',
      'systemClock',
      'TimeValidationError',
      'timeZoneRuntime',
      'toDurationMs',
      'toInstantMs',
      'toIso',
      'toZoned',
      'version',
      'zonedToUtc',
    ];
    expect(Object.keys(time).sort()).toEqual([...expected].sort());
  });

  it("acceptance: parseDuration('5m') === 300000 and parseDuration('-1s') throws", () => {
    expect(time.parseDuration('5m')).toBe(300_000);
    expect(() => time.parseDuration('-1s')).toThrow(time.TimeValidationError);
  });

  it('isTimeValidationError recognises only its own errors', () => {
    let caught: unknown;
    try {
      time.fromIso('nope');
    } catch (error) {
      caught = error;
    }
    expect(time.isTimeValidationError(caught)).toBe(true);
    expect(time.isTimeValidationError(new Error('x'))).toBe(false);
  });
});
