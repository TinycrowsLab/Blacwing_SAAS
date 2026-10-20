import { Counter, exponentialBuckets, Gauge, Histogram, Registry } from 'prom-client';

/** Duration buckets: 5 ms doubling up to about 5.5 minutes (long streamed responses). */
const FIRST_BUCKET_MS = 5;
const BUCKET_FACTOR = 2;
const BUCKET_COUNT = 17;

export interface GatewayMetrics {
  readonly registry: Registry;
  readonly requests: Counter<'route' | 'status'>;
  readonly duration: Histogram<'route' | 'status'>;
  readonly inflight: Gauge;
  readonly providerRequests: Counter<'provider' | 'status'>;
  readonly providerLatency: Histogram<'provider'>;
}

/** A private registry per gateway instance, so tests and multiple instances never share counters. */
export function createGatewayMetrics(): GatewayMetrics {
  const registry = new Registry();
  return {
    registry,
    requests: new Counter({
      name: 'bw_gw_requests_total',
      help: 'Model gateway requests by matched route and response status.',
      labelNames: ['route', 'status'],
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'bw_gw_request_duration_ms',
      help: 'Model gateway request duration in milliseconds, until the last streamed byte.',
      labelNames: ['route', 'status'],
      buckets: exponentialBuckets(FIRST_BUCKET_MS, BUCKET_FACTOR, BUCKET_COUNT),
      registers: [registry],
    }),
    inflight: new Gauge({
      name: 'bw_gw_upstream_inflight',
      help: 'Upstream provider requests currently open.',
      registers: [registry],
    }),
    providerRequests: new Counter({
      name: 'bw_gw_provider_requests_total',
      help: 'Upstream provider calls by provider and outcome status (HTTP status, or an error class).',
      labelNames: ['provider', 'status'],
      registers: [registry],
    }),
    providerLatency: new Histogram({
      name: 'bw_gw_provider_latency_ms',
      help: 'Time until the upstream provider answered with response headers, in milliseconds.',
      labelNames: ['provider'],
      buckets: exponentialBuckets(FIRST_BUCKET_MS, BUCKET_FACTOR, BUCKET_COUNT),
      registers: [registry],
    }),
  };
}
