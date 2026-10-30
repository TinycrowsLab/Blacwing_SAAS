import { Counter, Registry } from 'prom-client';

/** Tenant policy metrics (POLICY-001 observability). One private registry per instance. */
export interface TenantPolicyMetrics {
  readonly registry: Registry;
  /** `policy_versions_total`: versions appended. */
  readonly versions: Counter;
  /** `policy_activations_total{kind}`: `activated` or `rolled_back` pointer moves. */
  readonly activations: Counter<'kind'>;
}

export function createTenantPolicyMetrics(
  registry: Registry = new Registry(),
): TenantPolicyMetrics {
  return {
    registry,
    versions: new Counter({
      name: 'policy_versions_total',
      help: 'Tenant policy versions appended.',
      registers: [registry],
    }),
    activations: new Counter({
      name: 'policy_activations_total',
      help: 'Tenant policy active-pointer moves, by kind.',
      labelNames: ['kind'],
      registers: [registry],
    }),
  };
}
