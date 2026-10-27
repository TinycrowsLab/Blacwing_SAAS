import { Counter, Registry } from 'prom-client';

/** Keycloak Admin API metrics (IAM-002 observability). One private registry per instance. */
export interface KeycloakMetrics {
  readonly registry: Registry;
  /** `keycloak_admin_calls_total{op,result}`: one increment per logical admin call. */
  readonly calls: Counter<'op' | 'result'>;
}

export function createKeycloakMetrics(registry: Registry = new Registry()): KeycloakMetrics {
  return {
    registry,
    calls: new Counter({
      name: 'keycloak_admin_calls_total',
      help: 'Keycloak Admin API calls by operation and result (ok, not_found, conflict, error).',
      labelNames: ['op', 'result'],
      registers: [registry],
    }),
  };
}
