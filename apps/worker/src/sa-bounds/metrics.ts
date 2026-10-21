import { metrics } from '@opentelemetry/api';

import type { SaBoundsMetrics } from './ports.js';

// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- histogram bucket boundaries in seconds
const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];

/** The three SA-bounds instruments (ORCH-014). */
export function createOtelSaBoundsMetrics(): SaBoundsMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const expiry = meter.createCounter('blackwing_sa_expiry_total', {
    description: 'Runs stopped because their standing authorisation expired or was revoked',
  });
  const transitions = meter.createCounter('blackwing_window_transitions_total', {
    description: 'Test-window transitions by kind',
  });
  const latency = meter.createHistogram('blackwing_egress_block_latency_seconds', {
    description:
      'Seconds from SA expiry (or revocation) to the egress gateway acknowledging the block',
    unit: 's',
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS },
  });
  return {
    saExpiry: (reason) => {
      expiry.add(1, { reason });
    },
    windowTransition: (kind) => {
      transitions.add(1, { kind });
    },
    egressBlockLatency: (seconds) => {
      latency.record(seconds);
    },
  };
}
