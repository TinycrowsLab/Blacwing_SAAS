// Month boundaries for cost aggregation (COST-003): UTC by default and labelled, tenant-timezone boundaries that
// stay correct across DST, and refusal of malformed months and unknown zones (fail closed, never mis-bucket).

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { monthWindow } from './aggregate.js';

const HOUR_MS = 3_600_000;

describe('monthWindow (COST-003)', () => {
  it('defaults to UTC and labels the default', () => {
    const window = monthWindow('2026-10');
    expect(window.timeZone).toBe('UTC');
    expect(window.timeZoneSource).toBe('default');
    expect(window.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('labels a caller-supplied tenant timezone and canonicalises its name', () => {
    const window = monthWindow('2026-10', 'europe/berlin');
    expect(window.timeZone).toBe('Europe/Berlin');
    expect(window.timeZoneSource).toBe('tenant');
  });

  it('puts local midnight on the first of the month in the tenant zone (CEST, UTC+2)', () => {
    const window = monthWindow('2026-10', 'Europe/Berlin');
    expect(window.start.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    // Clocks go back on 25 October, so 1 November is CET (UTC+1). The window is 31 days plus the hour that
    // the change adds back: 745 elapsed hours, not 744.
    expect(window.end.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect((window.end.getTime() - window.start.getTime()) / HOUR_MS).toBe(745);
  });

  it('is DST-safe for a month that starts in standard time and ends in summer time', () => {
    const window = monthWindow('2026-03', 'Europe/Berlin');
    expect(window.start.toISOString()).toBe('2026-02-28T23:00:00.000Z');
    // The clocks move forward on 29 March, so 1 April local midnight is CEST (UTC+2).
    expect(window.end.toISOString()).toBe('2026-03-31T22:00:00.000Z');
  });

  it('is DST-safe across the US spring-forward change (EST to EDT)', () => {
    const window = monthWindow('2026-03', 'America/New_York');
    expect(window.start.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-04-01T04:00:00.000Z');
  });

  it('handles a zone east of UTC with a half-hour offset', () => {
    const window = monthWindow('2026-10', 'Asia/Kolkata');
    expect(window.start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });

  it('rolls December over into January of the next year', () => {
    const window = monthWindow('2026-12', 'Asia/Tokyo');
    expect(window.start.toISOString()).toBe('2026-11-30T15:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-12-31T15:00:00.000Z');
  });

  it.each(['2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', '', 'October 2026', '0999-01'])(
    'refuses the malformed month %j',
    (month) => {
      expect(() => monthWindow(month)).toThrow(ValidationError);
    },
  );

  it.each(['Mars/Olympus', '+02:00', ''])('refuses the unknown timezone %j', (zone) => {
    expect(() => monthWindow('2026-10', zone)).toThrow(ValidationError);
  });
});
