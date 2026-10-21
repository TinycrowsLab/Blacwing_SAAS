import { metrics } from '@opentelemetry/api';

import type { PreflightMetrics } from './ports.js';

// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- histogram bucket boundaries in seconds
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

/** `blackwing_preflight_check_total{check,status}` and `blackwing_preflight_duration_seconds`. */
export function createOtelPreflightMetrics(): PreflightMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const checks = meter.createCounter('blackwing_preflight_check_total', {
    description: 'Preflight check outcomes by check id and status',
  });
  const duration = meter.createHistogram('blackwing_preflight_duration_seconds', {
    description: 'Wall-clock duration of the preflight phase in seconds',
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  });
  return {
    checkResult: (check, status) => {
      checks.add(1, { check, status });
    },
    duration: (seconds) => {
      duration.record(seconds);
    },
  };
}
