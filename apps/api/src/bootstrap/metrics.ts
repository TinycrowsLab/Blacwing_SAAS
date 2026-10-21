import { Counter, Histogram, Registry } from 'prom-client';

/** `route` label of requests that matched no route (404s), so unbounded URLs never become labels. */
export const UNMATCHED_ROUTE = 'unmatched';

/** Bucket bounds in milliseconds; 5 ms up to 30 s, the useful range for a control-plane API. */
const DURATION_BUCKETS_MS = '5,10,25,50,100,250,500,1000,2500,5000,10000,30000';
const MS_PER_SECOND = 1000;
const DURATION_BUCKETS = DURATION_BUCKETS_MS.split(',').map((ms) => Number(ms) / MS_PER_SECOND);

export interface HttpMetrics {
  readonly registry: Registry;
  readonly requests: Counter<'method' | 'route' | 'status'>;
  readonly duration: Histogram<'method' | 'route' | 'status'>;
  /** Requests rejected by the Zod validation pipe, by matched route template (API-002). */
  readonly validationFailures: Counter<'route'>;
  /** `http_errors_total{code,status}`: every problem+json the exception filter rendered (API-004). */
  readonly errors: Counter<'code' | 'status'>;
  /** `optimistic_conflicts_total{route}`: `If-Match` mismatches answered 412 (API-007). */
  readonly optimisticConflicts: Counter<'route'>;
}

/** A private registry per app instance, so tests and multiple instances never share counters. */
export function createHttpMetrics(): HttpMetrics {
  const registry = new Registry();
  return {
    registry,
    requests: new Counter({
      name: 'http_server_requests_total',
      help: 'HTTP requests served by the API, by method, matched route template and response status.',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'http_server_request_duration_seconds',
      help: 'HTTP request duration in seconds, from the first byte read to the response sent.',
      labelNames: ['method', 'route', 'status'],
      buckets: DURATION_BUCKETS,
      registers: [registry],
    }),
    validationFailures: new Counter({
      name: 'http_validation_failures_total',
      help: 'Requests rejected by request validation (422), by matched route template.',
      labelNames: ['route'],
      registers: [registry],
    }),
    errors: new Counter({
      name: 'http_errors_total',
      help: 'Error responses rendered as problem+json, by stable error code and status.',
      labelNames: ['code', 'status'],
      registers: [registry],
    }),
    optimisticConflicts: new Counter({
      name: 'optimistic_conflicts_total',
      help: 'Mutations rejected with 412 because the If-Match ETag was stale, by matched route template.',
      labelNames: ['route'],
      registers: [registry],
    }),
  };
}
