/** The Temporal workflow that expires one standing authorisation (AUTHZ-010). Registered name, not a class. */
export const SA_EXPIRY_WORKFLOW = 'SaExpiryWorkflow';

/** Milliseconds per second: converts the seconds-based sweep interval to Temporal's millisecond timers. */
export const MS_PER_SECOND = 1_000;

/** Default sweep interval: the workflow re-checks the SA at least this often (`AUTHZ_EXPIRY_SWEEP_S`). */
export const DEFAULT_SA_EXPIRY_SWEEP_S = 60;

/** Longest single Temporal timer (6 hours), the same bound the SA-bounds workflow uses. */
export const SA_EXPIRY_MAX_TIMER_MS = 21_600_000;

/** One standing authorisation in its tenant. */
export interface SaExpiryRef {
  readonly tenantId: string;
  readonly saId: string;
}

/** Workflow input: the SA to expire and the sweep interval. The database `expires_at` decides expiry. */
export interface SaExpiryInput extends SaExpiryRef {
  /** Sweep interval in seconds; defaults to {@link DEFAULT_SA_EXPIRY_SWEEP_S}. */
  readonly sweepIntervalS?: number;
}

/**
 * What one expiry check found:
 * - `expired`: the SA was `active` and past `expires_at`; it is now `expired` (audited).
 * - `not_due`: still `active` before `expires_at`; `remainingMs` is the time left, per the database clock.
 * - `terminal`: the SA is no longer `active` (already expired, revoked, or never activated); nothing to do.
 */
export type SaExpiryOutcome =
  | { readonly kind: 'expired' }
  | { readonly kind: 'not_due'; readonly remainingMs: number }
  | { readonly kind: 'terminal' };

/** Activities of the expiry workflow. Each is idempotent: a second run on an expired SA is `terminal`. */
export interface SaExpiryActivities {
  /** Applies `active -> expired` once the database clock reached `expires_at`. */
  checkAndExpire(input: SaExpiryRef): Promise<SaExpiryOutcome>;
}
