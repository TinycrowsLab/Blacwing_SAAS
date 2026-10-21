import { Counter, Registry } from 'prom-client';

/** Run Broker metrics (API-014 observability). One private registry per instance. */
export interface BrokerMetrics {
  readonly registry: Registry;
  /** `broker_requests_total{endpoint,status}`: `endpoint` is the route pattern, never a raw path. */
  readonly requests: Counter<'endpoint' | 'status'>;
  /** `broker_auth_failures_total{reason}`: source refusals and token failures (reason is coarse). */
  readonly authFailures: Counter<'reason'>;
  /** Audit records that could not be written; pages. */
  readonly auditFailures: Counter<'endpoint'>;
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
  };
}
