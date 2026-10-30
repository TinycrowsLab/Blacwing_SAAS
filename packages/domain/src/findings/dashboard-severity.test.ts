import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import {
  dashboardSeverityOfBand,
  dashboardSeverityOfScore,
  storedBandOfSeverity,
} from './dashboard-severity.js';

describe('dashboardSeverityOfScore', () => {
  it.each([
    [0, 'info'],
    [0.1, 'low'],
    [3.9, 'low'],
    [4, 'medium'],
    [6.9, 'medium'],
    [7, 'high'],
    [8.9, 'high'],
    [9, 'critical'],
    [10, 'critical'],
  ])('buckets the CVSS v4.0 score %s as %s on the FIRST band edges', (score, expected) => {
    expect(dashboardSeverityOfScore(score)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 10.01])(
    'refuses the score %s instead of bucketing it',
    (score) => {
      expect(() => dashboardSeverityOfScore(score)).toThrow(ValidationError);
    },
  );
});

describe('dashboardSeverityOfBand and storedBandOfSeverity', () => {
  it('names the stored none band info, and maps the other bands one to one', () => {
    expect(dashboardSeverityOfBand('none')).toBe('info');
    expect(dashboardSeverityOfBand('low')).toBe('low');
    expect(storedBandOfSeverity('info')).toBe('none');
    expect(storedBandOfSeverity('critical')).toBe('critical');
  });
});
