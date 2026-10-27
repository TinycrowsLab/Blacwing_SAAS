import { metrics } from '@opentelemetry/api';

import type { OutboxRelayMetrics } from './ports.js';

// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- histogram bucket boundaries in seconds
const LATENCY_BUCKETS = [0.1, 0.5, 1, 5, 15, 60, 300, 1800, 7200];

/** `outbox_dispatched_total{type}`, `outbox_failed_total{type}`, `outbox_backlog{type}`, `outbox_dispatch_latency_seconds`. */
export function createOtelOutboxMetrics(): OutboxRelayMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const dispatched = meter.createCounter('outbox_dispatched_total', {
    description: 'Outbox rows delivered to their destination',
  });
  const failed = meter.createCounter('outbox_failed_total', {
    description: 'Outbox rows that became terminally failed (alert on any increase)',
  });
  const retried = meter.createCounter('outbox_retry_total', {
    description: 'Outbox deliveries that failed and were rescheduled with backoff',
  });
  const latency = meter.createHistogram('outbox_dispatch_latency_seconds', {
    description: 'Seconds from outbox row creation to successful dispatch',
    unit: 's',
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS },
  });
  const backlog = new Map<string, number>();
  meter
    .createObservableGauge('outbox_backlog', { description: 'Pending outbox rows by type' })
    .addCallback((result) => {
      for (const [type, count] of backlog) result.observe(count, { type });
    });
  return {
    dispatched: (type) => {
      dispatched.add(1, { type });
    },
    failed: (type) => {
      failed.add(1, { type });
    },
    retried: (type) => {
      retried.add(1, { type });
    },
    dispatchLatency: (seconds) => {
      latency.record(seconds);
    },
    backlog: (type, count) => {
      backlog.set(type, count);
    },
  };
}
