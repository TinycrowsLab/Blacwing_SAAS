import { metrics } from '@opentelemetry/api';

import type { SessionMetrics } from './ports.js';

// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- histogram bucket boundaries in seconds
const SECONDS_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60];
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- histogram bucket boundaries in USD
const COST_BUCKETS = [0.01, 0.1, 0.5, 1, 5, 10, 50];

/** `blackwing_session_total{persona,subtype}`, `blackwing_session_cost_usd`, sandbox provision/teardown seconds. */
export function createOtelSessionMetrics(): SessionMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const total = meter.createCounter('blackwing_session_total', {
    description: 'Finished agent sessions by persona and SDK result subtype',
  });
  const cost = meter.createHistogram('blackwing_session_cost_usd', {
    description: 'Cost of one agent session in USD',
    unit: 'USD',
    advice: { explicitBucketBoundaries: COST_BUCKETS },
  });
  const provision = meter.createHistogram('blackwing_sandbox_provision_seconds', {
    description: 'Time to provision one sandbox',
    unit: 's',
    advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
  });
  const teardown = meter.createHistogram('blackwing_sandbox_teardown_seconds', {
    description: 'Time to destroy one sandbox',
    unit: 's',
    advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
  });
  return {
    sessionFinished: (persona, subtype, costUsd) => {
      total.add(1, { persona, subtype });
      cost.record(costUsd, { persona });
    },
    sandboxProvisioned: (seconds) => {
      provision.record(seconds);
    },
    sandboxTornDown: (seconds) => {
      teardown.record(seconds);
    },
  };
}
