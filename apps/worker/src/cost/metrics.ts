import { metrics } from '@opentelemetry/api';

import type { CostIngestMetrics } from './ports.js';

// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- histogram bucket boundaries in milliseconds
const LAG_BUCKETS_MS = [50, 250, 1_000, 5_000, 30_000, 120_000, 600_000];

/** `cost_ingest_events_total{outcome}`, `cost_ingest_unpriced_total{reason}`, `cost_ingest_lag_ms`. */
export function createOtelCostIngestMetrics(): CostIngestMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const events = meter.createCounter('cost_ingest_events_total', {
    description: 'Gateway usage events ingested into the cost ledger, by outcome',
  });
  const unpriced = meter.createCounter('cost_ingest_unpriced_total', {
    description: 'Usage recorded at zero cost because no price applies (alert on any increase)',
  });
  const lag = meter.createHistogram('cost_ingest_lag_ms', {
    description: 'Milliseconds from a usage event occurring to its ledger write',
    unit: 'ms',
    advice: { explicitBucketBoundaries: LAG_BUCKETS_MS },
  });
  return {
    event: (outcome) => {
      events.add(1, { outcome });
    },
    unpriced: (reason) => {
      unpriced.add(1, { reason });
    },
    lagMs: (ms) => {
      lag.record(ms);
    },
  };
}
