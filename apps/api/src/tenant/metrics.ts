import { Counter, type Registry } from 'prom-client';

import type { TenantContextMetrics } from '@blackwing/db/tenant-context';

/** Tenant-context metrics (TENANT-003 observability), on the app's registry. */
export function createTenantContextMetrics(registry: Registry): TenantContextMetrics {
  const missing = new Counter({
    name: 'bw_tenant_context_missing_total',
    help: 'Requests refused because no tenant context could be resolved (fail closed).',
    registers: [registry],
  });
  const denied = new Counter({
    name: 'bw_cross_tenant_denied_total',
    help: 'Accesses denied because the resource belongs to another tenant. Alert on any increase.',
    registers: [registry],
  });
  return {
    contextMissing: () => {
      missing.inc();
    },
    crossTenantDenied: () => {
      denied.inc();
    },
  };
}
