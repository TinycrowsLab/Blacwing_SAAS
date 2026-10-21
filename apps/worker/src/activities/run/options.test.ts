import { describe, expect, it } from 'vitest';

import {
  CONTROL_ACTIVITY_OPTIONS,
  DEFAULT_RETRY,
  ONCE_RETRY,
  PHASE_ACTIVITY_OPTIONS,
} from './options.js';

describe('run activity retry policies', () => {
  it('defaults to 3 attempts with exponential backoff', () => {
    expect(DEFAULT_RETRY.maximumAttempts).toBe(3);
    expect(DEFAULT_RETRY.backoffCoefficient).toBeGreaterThan(1);
    expect(CONTROL_ACTIVITY_OPTIONS.retry).toBe(DEFAULT_RETRY);
  });

  it('runs the activities that send target traffic exactly once', () => {
    for (const name of ['runRecon', 'runExecution', 'runValidation'] as const) {
      expect(PHASE_ACTIVITY_OPTIONS[name].retry).toBe(ONCE_RETRY);
    }
    expect(ONCE_RETRY.maximumAttempts).toBe(1);
  });

  it('retries the idempotent phases and gives every activity a timeout', () => {
    for (const name of ['runPreflight', 'runPlanning', 'runReporting'] as const) {
      expect(PHASE_ACTIVITY_OPTIONS[name].retry.maximumAttempts).toBe(3);
    }
    for (const opts of Object.values(PHASE_ACTIVITY_OPTIONS)) {
      expect(opts.startToCloseTimeout).toBeTruthy();
    }
  });
});
