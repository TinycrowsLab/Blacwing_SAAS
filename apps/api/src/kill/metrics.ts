import { Counter, exponentialBuckets, Histogram, Registry } from 'prom-client';

import { KILL_EVENTS_TOTAL_METRIC } from '@blackwing/contracts';

/** Latency buckets: 1 ms doubling up to about 8 s (the kill path never awaits propagation). */
const LATENCY_BUCKET_COUNT = 14;

type KillEventLabel = (typeof KILL_EVENTS_TOTAL_METRIC.labels)[number];

/** Kill trigger metrics (KILL-003 observability). One private registry per instance. */
export interface KillMetrics {
  readonly registry: Registry;
  /** `bw_kill_events_total{scope,source,status}`: the contract in `@blackwing/contracts`. */
  readonly events: Counter<KillEventLabel>;
  /** `bw_kill_trigger_latency_ms`: request received to 202 written (propagation is not awaited). */
  readonly triggerLatency: Histogram<'scope'>;
  /** Propagation enqueue failures; the reconciler (KILL-004) retries, and this counter pages. */
  readonly enqueueFailures: Counter<'scope'>;
  /** Audit appends that failed after a kill was persisted; pages, the kill itself still proceeds. */
  readonly auditFailures: Counter<'action'>;
}

export function createKillMetrics(registry: Registry = new Registry()): KillMetrics {
  return {
    registry,
    events: new Counter({
      name: KILL_EVENTS_TOTAL_METRIC.name,
      help: KILL_EVENTS_TOTAL_METRIC.help,
      labelNames: [...KILL_EVENTS_TOTAL_METRIC.labels],
      registers: [registry],
    }),
    triggerLatency: new Histogram({
      name: 'bw_kill_trigger_latency_ms',
      help: 'Kill trigger API latency in milliseconds, request to 202.',
      labelNames: ['scope'],
      buckets: exponentialBuckets(1, 2, LATENCY_BUCKET_COUNT),
      registers: [registry],
    }),
    enqueueFailures: new Counter({
      name: 'bw_kill_enqueue_failures_total',
      help: 'Kill propagation enqueue failures (the kill event stays initiated for the reconciler).',
      labelNames: ['scope'],
      registers: [registry],
    }),
    auditFailures: new Counter({
      name: 'bw_kill_audit_failures_total',
      help: 'Kill audit events that could not be appended to the ledger.',
      labelNames: ['action'],
      registers: [registry],
    }),
  };
}
