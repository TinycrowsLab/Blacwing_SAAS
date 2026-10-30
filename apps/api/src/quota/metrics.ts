import { Counter, type Registry } from 'prom-client';

/** Quota metrics (TENANT-009). Labels are the resource only: never a tenant id or a count. */
export interface QuotaMetrics {
  /** One refused creation, by resource (`assets`, `concurrent_runs`, `members`, `monthly_cost`). */
  exceeded(resource: string): void;
}

/** `bw_quota_exceeded_total{resource}` on the app's registry. */
export function createQuotaMetrics(registry: Registry): QuotaMetrics {
  const counter = new Counter({
    name: 'bw_quota_exceeded_total',
    help: 'Creations refused because a tenant reached a plan quota or cost cap, by resource.',
    labelNames: ['resource'],
    registers: [registry],
  });
  return {
    exceeded: (resource) => {
      counter.inc({ resource });
    },
  };
}
