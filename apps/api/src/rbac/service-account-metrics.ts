import { Gauge, type Registry } from 'prom-client';

/** Service-account metrics (RBAC-005 observability). The gauge carries no labels: no tenant or account id. */
export interface ServiceAccountMetrics {
  /** Moves the active-account gauge: +1 when an account becomes active, -1 when it is disabled. */
  activeChanged(delta: 1 | -1): void;
}

/**
 * `service_accounts_active` on the app's registry. It is process-local: it tracks the changes this process
 * committed since it started, across tenants, so it is not a census of the database (a count query is the
 * follow-up when the metric must survive a restart).
 */
export function createServiceAccountMetrics(registry: Registry): ServiceAccountMetrics {
  const gauge = new Gauge({
    name: 'service_accounts_active',
    help: 'Active service accounts changed by this process since start (+1 on create or re-enable, -1 on disable).',
    registers: [registry],
  });
  return {
    activeChanged: (delta) => {
      if (delta > 0) gauge.inc();
      else gauge.dec();
    },
  };
}
