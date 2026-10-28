// Process-wide wiring of the BFF auth service (IAM-002, #334). Built lazily on first use so
// `next build` needs no secrets, and so an invalid environment fails the request (500, key names in
// the log only) instead of crashing the build. Server-only.

import { createLogger } from '@blackwing/logger';

import { loadAuthConfig, type AuthConfig } from './config.js';
import { createKeycloakSessionLogout } from './keycloak-logout.js';
import { createAuthMetrics } from './metrics.js';
import { createOidcClient } from './oidc.js';
import { createSessionRevoker, type SessionRevoker } from './revocation.js';
import { createAuthService, type AuthAuditEvent, type AuthService } from './service.js';
import { createSessionStore, createValkey } from './session-store.js';

export interface AuthRuntime {
  readonly config: AuthConfig;
  readonly service: AuthService;
  /** Programmatic revocation for user disable, tenant suspension and admin actions (#336). */
  readonly revocation: SessionRevoker;
}

let runtime: AuthRuntime | undefined;

export function getAuthRuntime(): AuthRuntime {
  if (runtime !== undefined) return runtime;
  const config = loadAuthConfig();
  const log = createLogger('web-auth');
  const now = (): number => Date.now();
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const store = createSessionStore(createValkey(config.redisUrl), config.sessionKeys, now);
  const metrics = createAuthMetrics();
  // The audit ledger writer arrives with IAM-012 (#340); until then login, logout and revocation events
  // are structured log lines (no tokens, no PII beyond ids).
  const audit = (event: AuthAuditEvent): void => {
    log.info({ audit: event }, event.action);
  };
  const idp =
    config.sessionAdmin === undefined
      ? undefined
      : createKeycloakSessionLogout({ issuer: config.issuer, ...config.sessionAdmin }, { fetch });
  runtime = {
    config,
    service: createAuthService({
      config,
      oidc: createOidcClient(config, { fetch, now }),
      store,
      metrics,
      audit,
      now,
      sleep,
    }),
    revocation: createSessionRevoker({ store, metrics, audit, idp, logger: log, sleep }),
  };
  return runtime;
}
