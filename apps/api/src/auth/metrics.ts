import { Counter, type Registry } from 'prom-client';

/** Which validator ran: `none` when no credential was presented or the header was malformed. */
export type AuthPath = 'keycloak' | 'session' | 'bearer' | 'none';
export type AuthResult = 'success' | 'no_credentials' | 'invalid' | 'expired' | 'unavailable';

export interface AuthMetrics {
  /** `auth_validate_total{path,result}`. */
  readonly validated: (path: AuthPath, result: AuthResult) => void;
  /** `jwks_refetch_total`: every attempt to fetch the IdP's signing keys. */
  readonly jwksFetch: () => void;
}

/** Auth counters on the app's registry. Label values are bounded codes, never user data or tokens. */
export function createAuthMetrics(registry: Registry): AuthMetrics {
  const validate = new Counter({
    name: 'auth_validate_total',
    help: 'Authentication decisions of the global auth guard, by validator path and result.',
    labelNames: ['path', 'result'] as const,
    registers: [registry],
  });
  const refetch = new Counter({
    name: 'jwks_refetch_total',
    help: 'Attempts to fetch the IdP signing keys (unknown kid, expiry or cold start).',
    registers: [registry],
  });
  return {
    validated: (path, result) => {
      validate.inc({ path, result });
    },
    jwksFetch: () => {
      refetch.inc();
    },
  };
}
