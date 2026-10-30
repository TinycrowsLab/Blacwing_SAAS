import type { SaExpiryMetrics, SaExpiryStore } from './ports.js';
import type { SaExpiryActivities } from './types.js';
import type { Logger } from '@blackwing/logger';

export interface SaExpiryActivityDeps {
  readonly store: SaExpiryStore;
  readonly metrics: SaExpiryMetrics;
  readonly log: Logger;
}

/** Builds the expiry activities over their ports. Each call is idempotent (see {@link SaExpiryStore}). */
export function createSaExpiryActivities(deps: SaExpiryActivityDeps): SaExpiryActivities {
  return {
    async checkAndExpire(ref) {
      const outcome = await deps.store.checkAndExpire(ref);
      if (outcome.kind === 'expired') {
        deps.metrics.expired();
        deps.log.info({ saId: ref.saId }, 'standing authorisation expired');
      }
      return outcome;
    },
  };
}
