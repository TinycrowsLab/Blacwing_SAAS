import { Counter, exponentialBuckets, Histogram, Registry } from 'prom-client';

/** Labels of one audit query: the role that answered it (`auditor`, `org_admin` or `other`). */
interface AuditQueryObservation {
  readonly role: string;
  readonly latencySeconds: number;
}

/** Audit query metrics (#86 observability). One private registry per instance. */
export interface AuditQueryMetrics {
  readonly registry: Registry;
  record(observation: AuditQueryObservation): void;
}

/** Latency buckets: 1 ms doubling up to about 8 s. */
const LATENCY_BUCKET_COUNT = 14;
/** The smallest latency bucket: 1 ms. */
const LATENCY_BASE_SECONDS = 0.001;

export function createAuditQueryMetrics(registry: Registry = new Registry()): AuditQueryMetrics {
  const queries = new Counter({
    name: 'audit_query_total',
    help: 'Audit ledger queries answered, by the role of the caller.',
    labelNames: ['role'],
    registers: [registry],
  });
  const latency = new Histogram({
    name: 'audit_query_latency_seconds',
    help: 'Audit ledger query latency in seconds, request to answer.',
    buckets: exponentialBuckets(LATENCY_BASE_SECONDS, 2, LATENCY_BUCKET_COUNT),
    registers: [registry],
  });
  return {
    registry,
    record({ role, latencySeconds }) {
      queries.inc({ role });
      latency.observe(latencySeconds);
    },
  };
}
