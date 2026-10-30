import {
  DEFAULT_SA_EXPIRY_SWEEP_S,
  MS_PER_SECOND,
  SA_EXPIRY_MAX_TIMER_MS,
  type SaExpiryActivities,
  type SaExpiryInput,
  type SaExpiryOutcome,
} from './types.js';

/** Wait seam: the workflow passes Temporal's `condition`/`sleep`; tests pass a fake clock. */
export interface SaExpiryControl {
  /** Resolves after `ms` of (durable) time. */
  sleep(ms: number): Promise<void>;
}

/**
 * AUTHZ-010: moves one standing authorisation from `active` to `expired` at its `expires_at`.
 *
 * The periodic sweep is the source of truth: every iteration asks the database (`checkAndExpire`) and waits
 * at most one sweep interval, so an SA is expired within one interval even if a timer was lost. The timer
 * is an optimisation: the wait is cut to the database-reported remaining time when that is shorter, so the
 * expiry usually lands on the due instant. Waits are capped at {@link SA_EXPIRY_MAX_TIMER_MS}. The workflow
 * ends once the SA is `expired` or no longer `active`, which makes a re-started workflow a no-op.
 *
 * Workflows never read the wall clock: the only clock is the database's, read inside the activity.
 */
export async function runSaExpiry(
  input: SaExpiryInput,
  acts: SaExpiryActivities,
  ctl: SaExpiryControl,
): Promise<SaExpiryOutcome['kind']> {
  const sweepMs = Math.min(
    SA_EXPIRY_MAX_TIMER_MS,
    (input.sweepIntervalS ?? DEFAULT_SA_EXPIRY_SWEEP_S) * MS_PER_SECOND,
  );
  for (;;) {
    const outcome = await acts.checkAndExpire({ tenantId: input.tenantId, saId: input.saId });
    if (outcome.kind !== 'not_due') return outcome.kind;
    await ctl.sleep(Math.min(sweepMs, Math.max(1, outcome.remainingMs)));
  }
}
