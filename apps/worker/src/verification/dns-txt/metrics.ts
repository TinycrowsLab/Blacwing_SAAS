import { metrics } from '@opentelemetry/api';

import type { VerificationDnsMetrics } from './activities.js';

/** `asset_verification_dns_total{result}` (ASSET-005). The label holds the outcome class only, never a name or token. */
export function createOtelVerificationDnsMetrics(): VerificationDnsMetrics {
  const counter = metrics
    .getMeter('@blackwing/worker')
    .createCounter('asset_verification_dns_total', {
      description: 'DNS TXT ownership probes by result (passed, not_found, resolver_error)',
    });
  return {
    result: (result) => {
      counter.add(1, { result });
    },
  };
}
