import { Counter, Histogram, type Registry } from 'prom-client';

/** Rate-limit metrics (on the app's registry). The `scope` label is one of `principal`, `tenant`, `ip`. */
export interface RateLimitMetrics {
  /** `rate_limit_blocked_total{routeClass,scope}`: requests refused with 429. */
  readonly blocked: Counter<'routeClass' | 'scope'>;
  /** `rate_limit_degraded_total`: checks answered by the in-process fallback because the shared limiter failed. */
  readonly degraded: Counter;
  /** `rate_limit_check_duration_seconds`: time to decide one check, including a fallback. */
  readonly checkDuration: Histogram;
}

/** Bucket bounds of the check duration, in milliseconds. */
const CHECK_DURATION_BUCKETS_MS = '0.5,1,2.5,5,10,25,50,100,250';
const MS_PER_SECOND = 1000;
const CHECK_DURATION_BUCKETS_S = CHECK_DURATION_BUCKETS_MS.split(',').map(
  (ms) => Number(ms) / MS_PER_SECOND,
);

export function createRateLimitMetrics(registry: Registry): RateLimitMetrics {
  return {
    blocked: new Counter({
      name: 'rate_limit_blocked_total',
      help: 'Requests refused with 429 by the rate limiter, by route class and the scope of the empty bucket.',
      labelNames: ['routeClass', 'scope'],
      registers: [registry],
    }),
    degraded: new Counter({
      name: 'rate_limit_degraded_total',
      help: 'Rate-limit checks decided by the in-process fallback because the shared limiter (Valkey) failed.',
      registers: [registry],
    }),
    checkDuration: new Histogram({
      name: 'rate_limit_check_duration_seconds',
      help: 'Time to decide one rate-limit check, in seconds.',
      buckets: CHECK_DURATION_BUCKETS_S,
      registers: [registry],
    }),
  };
}
