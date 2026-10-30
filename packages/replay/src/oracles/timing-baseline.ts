import { oracleParamsSchemas, TIMING_SAMPLES_DEFAULT } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import { median, medianAbsoluteDeviation } from './stats.js';

import type { OracleVerdict } from '../oracle.js';
import type { SignalStore } from './signals.js';
import type { RawObservation } from '../engine.js';

/**
 * The `timing_baseline` evaluator (VALIDATE-003, blind and time-based classes). It fires only when the probe is
 * slower than the declared baseline by `minDeltaMs` in the median AND in a majority of the timed samples. A single
 * outlier cannot move the median, and a single slow sample cannot carry the majority, so one spike never confirms.
 * Samples that jitter by at least `minDeltaMs` are too noisy to separate and are reported as flaky, never fired.
 */

/** Verdict reasons. Stable codes for logs and the validator, never timings or bodies. */
export const TIMING_REASONS = {
  insufficientSamples: 'insufficient_samples',
  noTimingSignal: 'no_timing_signal',
  tooNoisy: 'too_noisy',
  belowDelta: 'below_delta',
  notConsistent: 'not_consistent',
  separated: 'separated_from_baseline',
} as const;

/**
 * Builds the evaluator over `signals`. The baseline comes from the binding's `baselineMs`; the probe samples come from
 * the recorded timing signal for the observation's replay.
 */
export function timingBaselineEvaluator(signals: SignalStore) {
  return (observation: RawObservation, params: unknown): OracleVerdict => {
    const parsed = oracleParamsSchemas.timing_baseline.safeParse(params);
    if (!parsed.success) throw new ValidationError('timing_baseline params are invalid');
    const { baselineMs, minDeltaMs } = parsed.data;
    const samples = parsed.data.samples ?? TIMING_SAMPLES_DEFAULT;

    const timing = signals(observation.replayId)?.timing;
    if (timing === undefined) return { matched: false, reason: TIMING_REASONS.noTimingSignal };
    if (timing.probeMs.length < samples) {
      return { matched: false, reason: TIMING_REASONS.insufficientSamples };
    }
    const probe = timing.probeMs.slice(0, samples);
    if (probe.some((value) => !Number.isFinite(value) || value < 0)) {
      return { matched: false, reason: TIMING_REASONS.noTimingSignal };
    }

    // Jitter at least as large as the effect means the difference cannot be told apart from noise.
    if (medianAbsoluteDeviation(probe) >= minDeltaMs) {
      return { matched: false, reason: TIMING_REASONS.tooNoisy };
    }

    const centre = median(probe);
    if (centre - baselineMs < minDeltaMs)
      return { matched: false, reason: TIMING_REASONS.belowDelta };

    const slowerSamples = probe.filter((value) => value - baselineMs >= minDeltaMs).length;
    if (slowerSamples * 2 <= samples)
      return { matched: false, reason: TIMING_REASONS.notConsistent };

    return { matched: true, reason: TIMING_REASONS.separated };
  };
}
