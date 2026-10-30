import { describe, expect, it } from 'vitest';

import { exchange, observation } from './fixtures.js';
import { OracleBaselineMissingError } from './shared.js';
import { evaluateStatusDiff } from './status-diff.js';

const PARAMS = { expectedStatus: 200, baselineStatus: 403 };

describe('evaluateStatusDiff', () => {
  it('fires when the probe returns the expected status that differs from the baseline', () => {
    expect(evaluateStatusDiff(observation([exchange({ status: 200 })]), PARAMS)).toEqual({
      matched: true,
      reason: 'status_matches_expected',
    });
  });

  it('does not fire when the probe returns another status', () => {
    expect(evaluateStatusDiff(observation([exchange({ status: 403 })]), PARAMS)).toEqual({
      matched: false,
      reason: 'status_differs',
    });
  });

  it('returns no_observation when the probe has no status', () => {
    expect(evaluateStatusDiff(observation([exchange({ status: null })]), PARAMS)).toEqual({
      matched: false,
      reason: 'no_observation',
    });
    expect(evaluateStatusDiff(observation([]), PARAMS)).toEqual({
      matched: false,
      reason: 'no_observation',
    });
  });

  it('errors when the baseline is missing, so the candidate stays Suspected', () => {
    expect(() => evaluateStatusDiff(observation([exchange()]), { expectedStatus: 200 })).toThrow(
      OracleBaselineMissingError,
    );
  });

  it('refuses params whose expected and baseline statuses are equal, without firing', () => {
    expect(
      evaluateStatusDiff(observation([exchange({ status: 200 })]), {
        expectedStatus: 200,
        baselineStatus: 200,
      }),
    ).toEqual({ matched: false, reason: 'invalid_params' });
  });

  it('refuses an out-of-range status and extra keys without firing', () => {
    expect(
      evaluateStatusDiff(observation([exchange({ status: 200 })]), {
        expectedStatus: 999,
        baselineStatus: 403,
      }),
    ).toEqual({ matched: false, reason: 'invalid_params' });
    expect(
      evaluateStatusDiff(observation([exchange({ status: 200 })]), { ...PARAMS, body: 'x' }),
    ).toEqual({ matched: false, reason: 'invalid_params' });
  });
});
