import { Counter, type Registry } from 'prom-client';

/** Settings-API metrics (TENANT-008 observability). No labels: a per-value label would explode cardinality. */
export interface TenantSettingsMetrics {
  /** Counts committed changes only; no-op PATCHes do not count. */
  updated(): void;
}

/** `bw_tenant_settings_updated_total` on the app's registry. */
export function createTenantSettingsMetrics(registry: Registry): TenantSettingsMetrics {
  const counter = new Counter({
    name: 'bw_tenant_settings_updated_total',
    help: 'Tenant settings changes committed.',
    registers: [registry],
  });
  return {
    updated: () => {
      counter.inc();
    },
  };
}
