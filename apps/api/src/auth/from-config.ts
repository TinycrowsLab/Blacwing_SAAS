import { deriveKey } from '@blackwing/crypto';

import { createJwksCache } from './jwks.js';
import { createKeycloakJwtValidator } from './keycloak-jwt.js';
import { createAuthMetrics } from './metrics.js';
import { createSessionCookieValidator, type SessionValkey } from './session-cookie.js';

import type { AuthOptions } from './module.js';
import type { ApiConfig } from '../config.js';
import type { Logger } from '@blackwing/logger';
import type { Registry } from 'prom-client';

/** Keycloak publishes its signing keys under the realm's OIDC endpoint. */
const KEYCLOAK_JWKS_PATH = '/protocol/openid-connect/certs';

interface AuthFromConfigOptions {
  readonly config: Readonly<ApiConfig>;
  readonly logger: Logger;
  readonly registry: Registry;
  /** Read access to the BFF's Valkey. Absent, BFF session cookies are refused (fail closed). */
  readonly sessionValkey?: SessionValkey | undefined;
  readonly now?: () => number;
}

/**
 * Builds the credential validators from configuration (#335). A path whose settings are absent stays off, so
 * its credentials are refused: the API never accepts a shape it cannot verify.
 */
export function authOptionsFromConfig(options: AuthFromConfigOptions): AuthOptions {
  const { config } = options;
  const now = options.now ?? Date.now;
  const metrics = createAuthMetrics(options.registry);

  const issuer = config.KEYCLOAK_ISSUER_URL;
  const keycloak =
    issuer === undefined
      ? undefined
      : createKeycloakJwtValidator({
          issuer,
          audience: config.API_JWT_AUDIENCE,
          leewaySeconds: config.API_JWT_LEEWAY_SECONDS,
          now,
          resolveKey: createJwksCache({
            url: issuer.replace(/\/+$/, '') + KEYCLOAK_JWKS_PATH,
            ttlMs: config.API_JWKS_TTL_MS,
            refetchCooldownMs: config.API_JWKS_REFETCH_COOLDOWN_MS,
            timeoutMs: config.API_JWKS_TIMEOUT_MS,
            now,
            onFetch: metrics.jwksFetch,
          }).resolve,
        });

  const session =
    config.BW_WEB_SESSION_SECRET === undefined || options.sessionValkey === undefined
      ? undefined
      : createSessionCookieValidator({
          keys: sessionKeys(config.BW_WEB_SESSION_SECRET, config.BW_WEB_SESSION_SECRET_PREVIOUS),
          valkey: options.sessionValkey,
          now,
        });

  return { keycloak, session, metrics, logger: options.logger };
}

/** The BFF keys: the current secret seals and opens, the previous one only opens (rotation without sign-out). */
function sessionKeys(current: string, previous: string | undefined): [Buffer, ...Buffer[]] {
  const keys: [Buffer, ...Buffer[]] = [deriveKey(current)];
  if (previous !== undefined) keys.push(deriveKey(previous));
  return keys;
}
