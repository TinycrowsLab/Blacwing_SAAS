// Process-wide wiring of the platform-operator BFF (#838). Built lazily on first use so `next build` needs no
// secrets, and an invalid environment fails the request (500, key names in the log only). Server-only.

import { createLogger } from '@blackwing/logger';

import { loadOperatorAuthConfig, type OperatorAuthConfig } from './config.js';
import { createOperatorAuthMetrics } from './metrics.js';
import {
  createOperatorAuthService,
  type OperatorAuditEvent,
  type OperatorAuthService,
} from './service.js';
import { createOperatorSessionStore, type OperatorSessionStore } from './session-store.js';
import { createOidcClient } from '../auth/oidc.js';
import { createValkey } from '../auth/session-store.js';

export interface OperatorAuthRuntime {
  readonly config: OperatorAuthConfig;
  readonly service: OperatorAuthService;
}

let runtime: OperatorAuthRuntime | undefined;

export function getOperatorAuthRuntime(): OperatorAuthRuntime {
  if (runtime !== undefined) return runtime;
  const config = loadOperatorAuthConfig();
  const log = createLogger('operator-auth');
  const now = (): number => Date.now();
  const store: OperatorSessionStore = createOperatorSessionStore(
    createValkey(config.redisUrl),
    config.sessionKeys,
    now,
  );
  runtime = {
    config,
    service: createOperatorAuthService({
      config,
      oidc: createOidcClient(config, { fetch, now }),
      store,
      metrics: createOperatorAuthMetrics(),
      // OFFLINE-STUB(online-porting #906): the platform ledger writer arrives with IAM-012. Until then operator events
      // are structured log lines carrying ids and codes only (no tokens, no tenant).
      audit: (event: OperatorAuditEvent) => {
        log.info({ audit: event }, event.action);
      },
      now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
  };
  return runtime;
}
