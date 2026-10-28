import { sessionKeys } from '../from-config.js';
import { createJwksCache } from '../jwks.js';
import { createOperatorAuthMetrics, type OperatorAuthMetrics } from './metrics.js';
import { createOperatorJwtValidator, type OperatorJwtValidator } from './operator-jwt.js';
import {
  createOperatorSessionValidator,
  type OperatorSessionValidator,
} from './operator-session.js';

import type { AuthOptions } from '../module.js';
import type { OperatorAuthAuditSink, OperatorAuthOptions } from './require-operator.js';
import type { ApiConfig } from '../../config.js';
import type { SessionValkey } from '../session-cookie.js';
import type { Logger } from '@blackwing/logger';
import type { Registry } from 'prom-client';

/** Keycloak publishes its signing keys under the realm's OIDC endpoint (the same path for every realm). */
const KEYCLOAK_JWKS_PATH = '/protocol/openid-connect/certs';

export interface OperatorAuthFromConfigOptions {
  readonly config: Readonly<ApiConfig>;
  readonly logger: Logger;
  readonly registry: Registry;
  /** The tenant guard's options. Its probes classify a tenant credential at an operator route (NOT_OPERATOR). */
  readonly tenant: AuthOptions;
  /** Read access to the platform-operator BFF's Valkey. Absent, operator session cookies are refused. */
  readonly sessionValkey?: SessionValkey | undefined;
  readonly audit?: OperatorAuthAuditSink | undefined;
  readonly now?: () => number;
}

/**
 * Builds the platform-operator authentication from configuration (#838). A path whose settings are absent stays off,
 * so its credentials are refused: the operator guard never accepts a shape it cannot verify.
 */
export function operatorAuthOptionsFromConfig(
  options: OperatorAuthFromConfigOptions,
): OperatorAuthOptions {
  const { config, tenant } = options;
  const now = options.now ?? Date.now;
  const issuer = config.OPERATOR_KEYCLOAK_ISSUER_URL;
  const operatorJwt: OperatorJwtValidator | undefined =
    issuer === undefined
      ? undefined
      : createOperatorJwtValidator({
          issuer,
          audience: config.OPERATOR_API_JWT_AUDIENCE,
          leewaySeconds: config.API_JWT_LEEWAY_SECONDS,
          now,
          resolveKey: createJwksCache({
            url: issuer.replace(/\/+$/, '') + KEYCLOAK_JWKS_PATH,
            ttlMs: config.API_JWKS_TTL_MS,
            refetchCooldownMs: config.API_JWKS_REFETCH_COOLDOWN_MS,
            timeoutMs: config.API_JWKS_TIMEOUT_MS,
            now,
            onFetch: tenant.metrics.jwksFetch,
          }).resolve,
        });
  const operatorSession: OperatorSessionValidator | undefined =
    config.BW_OPERATOR_SESSION_SECRET === undefined || options.sessionValkey === undefined
      ? undefined
      : createOperatorSessionValidator({
          keys: sessionKeys(
            config.BW_OPERATOR_SESSION_SECRET,
            config.BW_OPERATOR_SESSION_SECRET_PREVIOUS,
          ),
          valkey: options.sessionValkey,
          now,
        });
  const metrics: OperatorAuthMetrics = createOperatorAuthMetrics(options.registry);
  return {
    ...(operatorJwt === undefined ? {} : { operatorJwt }),
    ...(operatorSession === undefined ? {} : { operatorSession }),
    tenant: { bearer: tenant.bearer, keycloak: tenant.keycloak, session: tenant.session },
    metrics,
    logger: options.logger,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  };
}
