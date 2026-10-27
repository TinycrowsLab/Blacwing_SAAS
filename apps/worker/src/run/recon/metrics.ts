import { metrics } from '@opentelemetry/api';

import type { ReconMetrics } from './ports.js';

// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- histogram bucket boundaries in seconds
const DURATION_BUCKETS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];

/** `blackwing_recon_sessions_total{persona,mode,status}` and `blackwing_recon_duration_seconds`. */
export function createOtelReconMetrics(): ReconMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const sessions = meter.createCounter('blackwing_recon_sessions_total', {
    description: 'Recon sessions by persona, run mode and final status',
  });
  const duration = meter.createHistogram('blackwing_recon_duration_seconds', {
    description: 'Wall-clock duration of the recon phase in seconds',
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  });
  return {
    session: (persona, mode, status) => {
      sessions.add(1, { persona, mode, status });
    },
    duration: (seconds) => {
      duration.record(seconds);
    },
  };
}
