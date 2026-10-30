import type { SaExpiryOutcome, SaExpiryRef } from './types.js';

/**
 * The standing-authorisation store the expiry check runs on. The Postgres adapter runs one tenant transaction
 * that reads the database clock, locks the row, applies the `expire` transition and writes `authz.sa.expired`
 * to the audit outbox in the same transaction.
 */
export interface SaExpiryStore {
  checkAndExpire(ref: SaExpiryRef): Promise<SaExpiryOutcome>;
}

/** `authz_sa_expired_total`: one count per SA this worker moved to `expired`. */
export interface SaExpiryMetrics {
  expired(): void;
}
