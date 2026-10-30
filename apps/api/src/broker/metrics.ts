import { Counter, exponentialBuckets, Histogram, Registry } from 'prom-client';

/** Gate 2 latency buckets: 5 ms doubling, 9 buckets (5 ms to 1.28 s). */
const GATE2_LATENCY_FIRST_BUCKET_MS = 5;
const GATE2_LATENCY_BUCKET_COUNT = 9;

/** Run Broker metrics (API-014 observability). One private registry per instance. */
export interface BrokerMetrics {
  readonly registry: Registry;
  /** `broker_requests_total{endpoint,status}`: `endpoint` is the route pattern, never a raw path. */
  readonly requests: Counter<'endpoint' | 'status'>;
  /** `broker_auth_failures_total{reason}`: source refusals and token failures (reason is coarse). */
  readonly authFailures: Counter<'reason'>;
  /** Audit records that could not be written; pages. */
  readonly auditFailures: Counter<'endpoint'>;
  /** `gate2_exceptions_created_total{batch}`: exceptions opened by a deferred call (not replays). */
  readonly gate2Created: Counter<'batch'>;
  /** `gate2_create_latency_ms`: time to persist and signal one Gate 2 exception. */
  readonly gate2CreateLatency: Histogram;
}

export function createBrokerMetrics(registry: Registry = new Registry()): BrokerMetrics {
  return {
    registry,
    requests: new Counter({
      name: 'broker_requests_total',
      help: 'Run Broker requests by route pattern and HTTP status.',
      labelNames: ['endpoint', 'status'],
      registers: [registry],
    }),
    authFailures: new Counter({
      name: 'broker_auth_failures_total',
      help: 'Run Broker requests refused for source, token or binding reasons.',
      labelNames: ['reason'],
      registers: [registry],
    }),
    auditFailures: new Counter({
      name: 'broker_audit_failures_total',
      help: 'Run Broker audit events that could not be recorded.',
      labelNames: ['endpoint'],
      registers: [registry],
    }),
    gate2Created: new Counter({
      name: 'gate2_exceptions_created_total',
      help: 'Gate 2 exceptions created from deferred tool calls.',
      labelNames: ['batch'],
      registers: [registry],
    }),
    gate2CreateLatency: new Histogram({
      name: 'gate2_create_latency_ms',
      help: 'Time to persist and signal one Gate 2 exception, in milliseconds.',
      buckets: exponentialBuckets(GATE2_LATENCY_FIRST_BUCKET_MS, 2, GATE2_LATENCY_BUCKET_COUNT),
      registers: [registry],
    }),
  };
}
