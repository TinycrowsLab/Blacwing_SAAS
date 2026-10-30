// Load profiles and the k6 options they produce (PERF-001, #320).
//
// Shapes: smoke 1 VU for 30s; load ramps to 50 VUs over 5m; stress ramps to 300 VUs over 5m; soak holds 20 VUs
// for 1h. Each profile is one scenario named "main", so every script reads the same options shape.

import { presetThresholds } from './thresholds.js';

export const PROFILES = Object.freeze(['smoke', 'load', 'stress', 'soak']);

/**
 * @param {string} profile one of PROFILES
 * @returns {Record<string, unknown>} k6 `scenarios` entry for that profile
 */
export function scenarioFor(profile) {
  switch (profile) {
    case 'smoke':
      return { executor: 'constant-vus', vus: 1, duration: '30s' };
    case 'load':
      return { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '5m', target: 50 }] };
    case 'stress':
      return { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '5m', target: 300 }] };
    case 'soak':
      return { executor: 'constant-vus', vus: 20, duration: '1h' };
    default:
      throw new Error(`unknown PERF_PROFILE "${profile}"; expected one of ${PROFILES.join('|')}`);
  }
}

/**
 * Builds the complete k6 `options` object for a profile.
 * Response bodies are discarded: checks read status codes only, which bounds memory on large or unicode bodies.
 *
 * @param {string} profile one of PROFILES
 * @returns {{ scenarios: { main: Record<string, unknown> }, thresholds: ReturnType<typeof presetThresholds>, discardResponseBodies: boolean }}
 */
export function buildOptions(profile) {
  return {
    scenarios: { main: scenarioFor(profile) },
    thresholds: presetThresholds(),
    discardResponseBodies: true,
  };
}
