import { Counter, Registry } from 'prom-client';

/** Retention policy metrics (RETAIN-001 observability). One private registry per instance. */
export interface RetentionMetrics {
  readonly registry: Registry;
  /** `retention_policy_updates_total{data_class}`: one increment per class a `PUT` actually changed. */
  readonly updates: Counter<'data_class'>;
}

export function createRetentionMetrics(registry: Registry = new Registry()): RetentionMetrics {
  return {
    registry,
    updates: new Counter<'data_class'>({
      name: 'retention_policy_updates_total',
      help: 'Retention policies changed by a tenant, per data class.',
      labelNames: ['data_class'],
      registers: [registry],
    }),
  };
}
