import { metrics } from '@opentelemetry/api';

import type { SaExpiryMetrics } from './ports.js';

/** The expiry counter (AUTHZ-010). */
export function createOtelSaExpiryMetrics(): SaExpiryMetrics {
  const counter = metrics.getMeter('@blackwing/worker').createCounter('authz_sa_expired_total', {
    description: 'Standing authorisations moved from active to expired at expires_at',
  });
  return {
    expired: () => {
      counter.add(1);
    },
  };
}
