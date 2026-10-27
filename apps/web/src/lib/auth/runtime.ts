// Process-wide wiring of the BFF auth service (IAM-002, #334). Built lazily on first use so
// `next build` needs no secrets, and so an invalid environment fails the request (500, key names in
// the log only) instead of crashing the build. Server-only.

import { createLogger } from '@blackwing/logger';

import { loadAuthConfig, type AuthConfig } from './config.js';
import { createAuthMetrics } from './metrics.js';
import { createOidcClient } from './oidc.js';
import { createAuthService, type AuthAuditEvent, type AuthService } from './service.js';
import { createSessionStore, createValkey } from './session-store.js';

export interface AuthRuntime {
  readonly config: AuthConfig;
  readonly service: AuthService;
}

let runtime: AuthRuntime | undefined;

export function getAuthRuntime(): AuthRuntime {
  if (runtime !== undefined) return runtime;
  const config = loadAuthConfig();
  const log = createLogger('web-auth');
  const now = (): number => Date.now();
  runtime = {
    config,
    service: createAuthService({
      config,
      oidc: createOidcClient(config, { fetch, now }),
      store: createSessionStore(createValkey(config.redisUrl), config.sessionKeys, now),
      metrics: createAuthMetrics(),
      // The audit ledger writer arrives with IAM-012 (#340); until then login and logout events are
      // structured log lines (no tokens, no PII beyond ids).
      audit: (event: AuthAuditEvent) => {
        log.info({ audit: event }, event.action);
      },
      now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
  };
  return runtime;
}
