// Process-wide wiring of the SOC portal BFF (SOCUI-001, #553). Built lazily on first use, so `next build`
// needs no portal secrets, and an invalid portal configuration fails the request, not the build. The
// audit writer is the log sink until the platform ledger writer lands (IAM-012), as for the console
// auth events. Server-only.

import { createLogger } from '@blackwing/logger';

import { loadSocPortalConfig, type SocPortalConfig } from './config.js';
import { createSocPortalLinkCounters, type SocPortalLinkDeps } from './link-open.js';

let config: SocPortalConfig | undefined;
let configLoaded = false;
let linkDeps: SocPortalLinkDeps | undefined;

/** The portal configuration, or `undefined` when the portal is disabled (every link is refused). */
export function getSocPortalConfig(): SocPortalConfig | undefined {
  if (!configLoaded) {
    config = loadSocPortalConfig();
    configLoaded = true;
  }
  return config;
}

/** The link-open dependencies, built once per process. */
export function getSocPortalLinkDeps(): SocPortalLinkDeps {
  if (linkDeps !== undefined) return linkDeps;
  const logger = createLogger('web-soc-portal');
  linkDeps = {
    config: getSocPortalConfig(),
    now: () => Date.now(),
    audit: (event) => {
      logger.info({ audit: event }, event.action);
    },
    logger,
    counters: createSocPortalLinkCounters(),
  };
  return linkDeps;
}
