import type { RunPhaseActivities } from './types.js';
import type { ActivityOptions } from '@temporalio/workflow';

// Retry policies for the run controller's activities (ORCH-002 req. 7): 3 attempts with exponential
// backoff, except activities that are not idempotent, which run once.

/** Default policy. */
export const DEFAULT_RETRY = Object.freeze({
  initialInterval: '1 second',
  backoffCoefficient: 2,
  maximumInterval: '30 seconds',
  maximumAttempts: 3,
} as const);

/** Non-idempotent: a retry could send target traffic twice. */
export const ONCE_RETRY = Object.freeze({ ...DEFAULT_RETRY, maximumAttempts: 1 } as const);

/** Persistence / audit / guard activities: short and idempotent. */
export const CONTROL_ACTIVITY_OPTIONS = Object.freeze({
  startToCloseTimeout: '30 seconds',
  retry: DEFAULT_RETRY,
} as const) satisfies ActivityOptions;

/** Per-phase options. Timeouts are generous upper bounds; ORCH-011 owns the real phase timers. */
export const PHASE_ACTIVITY_OPTIONS = Object.freeze({
  runPreflight: { startToCloseTimeout: '5 minutes', retry: DEFAULT_RETRY },
  runRecon: { startToCloseTimeout: '4 hours', retry: ONCE_RETRY },
  runPlanning: { startToCloseTimeout: '1 hour', retry: DEFAULT_RETRY },
  runExecution: { startToCloseTimeout: '24 hours', retry: ONCE_RETRY },
  runValidation: { startToCloseTimeout: '8 hours', retry: ONCE_RETRY },
  runReporting: { startToCloseTimeout: '1 hour', retry: DEFAULT_RETRY },
} as const satisfies Record<keyof RunPhaseActivities, ActivityOptions>);
