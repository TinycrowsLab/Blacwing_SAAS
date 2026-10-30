import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { observationWith } from './fixtures.js';
import { median, medianAbsoluteDeviation, mean } from './stats.js';
import { timingBaselineEvaluator, TIMING_REASONS } from './timing-baseline.js';

import type { ReplaySignals, SignalStore } from './signals.js';

const REPLAY_ID = '0190a000-0000-7000-8000-000000000001';
const params = { baselineMs: 100, minDeltaMs: 2000, samples: 5 };

function evaluate(probeMs: readonly number[] | undefined, p: unknown = params) {
  const signal: ReplaySignals | undefined =
    probeMs === undefined ? undefined : { timing: { probeMs } };
  const store: SignalStore = (id) => (id === REPLAY_ID ? signal : undefined);
  return timingBaselineEvaluator(store)(observationWith([], REPLAY_ID), p);
}

describe('timing_baseline evaluator', () => {
  it('fires when every sample is consistently slower than the baseline by the declared delta', () => {
    expect(evaluate([2400, 2500, 2450, 2600, 2300])).toEqual({
      matched: true,
      reason: TIMING_REASONS.separated,
    });
  });

  it('does not fire on a single outlier among fast samples (the median is not moved)', () => {
    const verdict = evaluate([120, 110, 130, 9000, 115]);
    expect(verdict.matched).toBe(false);
    expect(verdict.reason).toBe(TIMING_REASONS.belowDelta);
  });

  it('does not fire when the median clears the delta but only half the samples are slow', () => {
    // Four samples: the middle pair averages 2100 (clears the 2000 ms delta over the 100 ms baseline), yet only
    // two of the four samples are slow. Exactly half is not a majority, so the verdict is not consistent.
    const verdict = evaluate([0, 1000, 3200, 3200], { ...params, samples: 4 });
    expect(verdict).toEqual({ matched: false, reason: TIMING_REASONS.notConsistent });
  });

  it('does not fire when the samples are slow but the median is below the delta', () => {
    expect(evaluate([2100, 2100, 100, 100, 100]).matched).toBe(false);
  });

  it('does not fire on a probe that is not slower than the baseline', () => {
    expect(evaluate([100, 110, 90, 105, 95])).toEqual({
      matched: false,
      reason: TIMING_REASONS.belowDelta,
    });
  });

  it('treats jitter at least as large as the effect as too noisy to decide, never as a match', () => {
    // Median 2400 would clear the delta, but the spread is over 2000 ms, so the verdict is flaky.
    const verdict = evaluate([100, 2400, 4800, 2400, 9000]);
    expect(verdict).toEqual({ matched: false, reason: TIMING_REASONS.tooNoisy });
  });

  it('is Suspected when fewer samples than declared were recorded', () => {
    expect(evaluate([2500, 2500])).toEqual({
      matched: false,
      reason: TIMING_REASONS.insufficientSamples,
    });
  });

  it('is Suspected when no timing was recorded for the replay', () => {
    expect(evaluate(undefined)).toEqual({ matched: false, reason: TIMING_REASONS.noTimingSignal });
  });

  it('is Suspected on non-finite or negative timings', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(evaluate([2500, 2500, bad, 2500, 2500]).matched).toBe(false);
    }
  });

  it('uses only the declared number of samples and ignores extra recorded ones', () => {
    // The first three are slow; the trailing fast samples are beyond the declared count and are not used.
    expect(evaluate([2500, 2500, 2500, 10, 10], { ...params, samples: 3 }).matched).toBe(true);
  });

  it('defaults to five samples when the binding does not declare a count', () => {
    expect(evaluate([2500, 2500, 2500, 2500, 2500], { baselineMs: 100, minDeltaMs: 2000 })).toEqual(
      {
        matched: true,
        reason: TIMING_REASONS.separated,
      },
    );
    expect(evaluate([2500, 2500], { baselineMs: 100, minDeltaMs: 2000 })).toEqual({
      matched: false,
      reason: TIMING_REASONS.insufficientSamples,
    });
  });

  it('refuses malformed params at evaluation time instead of guessing', () => {
    expect(() => evaluate([2500, 2500, 2500], { baselineMs: 100 })).toThrow(ValidationError);
    expect(() => evaluate([2500, 2500, 2500], { ...params, extra: 'x' })).toThrow(ValidationError);
    expect(() => evaluate([2500, 2500, 2500], { ...params, samples: 2 })).toThrow(ValidationError);
  });
});

describe('robust statistics', () => {
  it('takes the median of odd and even samples', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('measures jitter as the median absolute deviation, not the range', () => {
    expect(medianAbsoluteDeviation([10, 10, 10, 10, 1000])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
  });
});
