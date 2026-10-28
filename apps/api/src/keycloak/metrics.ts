import { Counter, Gauge, Registry } from 'prom-client';

/** Keycloak Admin API metrics (IAM-002 observability). One private registry per instance. */
export interface KeycloakMetrics {
  readonly registry: Registry;
  /** `keycloak_admin_calls_total{op,result}`: one increment per logical admin call. */
  readonly calls: Counter<'op' | 'result'>;
  /** `sso_idp_config_total{type,op}`: one increment per applied organisation identity-provider change (IAM-004). */
  readonly identityProviderConfig: Counter<'type' | 'op'>;
  /** `sso_idp_signing_cert_expiry_days{alias}`: days until the SAML signing certificate in use expires. */
  readonly signingCertExpiryDays: Gauge<'alias'>;
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
    identityProviderConfig: new Counter({
      name: 'sso_idp_config_total',
      help: 'Applied organisation identity-provider changes by type (oidc, saml) and operation (create, update, delete).',
      labelNames: ['type', 'op'],
      registers: [registry],
    }),
    signingCertExpiryDays: new Gauge({
      name: 'sso_idp_signing_cert_expiry_days',
      help: 'Days until the SAML signing certificate currently configured for an identity provider expires.',
      labelNames: ['alias'],
      registers: [registry],
    }),
  };
}
