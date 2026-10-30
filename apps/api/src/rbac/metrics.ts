import { Counter, type Registry } from 'prom-client';

/** RBAC metrics (RBAC-003 observability), on the app's registry. */
export interface RbacMetrics {
  /** `bw_rbac_denials_total{permission}`: one increment per refused RBAC check. */
  denied(permission: string): void;
}

/** RBAC metrics on the app's registry. */
export function createRbacMetrics(registry: Registry): RbacMetrics {
  const denials = new Counter({
    name: 'bw_rbac_denials_total',
    help: 'Requests refused by the RBAC permission guard, by required permission. Alert on any sustained increase.',
    labelNames: ['permission'] as const,
    registers: [registry],
  });
  return {
    denied: (permission) => {
      denials.inc({ permission });
    },
  };
}
