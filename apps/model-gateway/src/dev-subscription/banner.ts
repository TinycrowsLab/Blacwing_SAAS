import { DEV_SUBSCRIPTION_BANNER, DEV_SUBSCRIPTION_PROVIDER_ID } from './guard.js';

import type { GatewayAuditSink } from '../audit.js';
import type { Logger } from '@blackwing/logger';

export interface DevSubscriptionAnnouncementOptions {
  readonly logger: Logger;
  readonly audit: GatewayAuditSink;
  /** How often the WARN line repeats. */
  readonly intervalMs: number;
  /** Plain-text sink for the boot banner (stderr in the process entry point). */
  readonly write: (text: string) => void;
}

/**
 * Announces that the dev subscription provider is active: a plain-text banner, a WARN log line repeated
 * every `intervalMs`, and the `gateway.dev_provider.active` audit event. Returns a function that stops
 * the repetition (on shutdown).
 */
export function announceDevSubscription(options: DevSubscriptionAnnouncementOptions): () => void {
  const { logger, audit } = options;
  const fields = { provider: DEV_SUBSCRIPTION_PROVIDER_ID };
  const rule = '='.repeat(DEV_SUBSCRIPTION_BANNER.length);
  options.write(`${rule}\n${DEV_SUBSCRIPTION_BANNER}\n${rule}\n`);
  logger.warn(fields, DEV_SUBSCRIPTION_BANNER);
  audit.record({ type: 'gateway.dev_provider.active', provider: DEV_SUBSCRIPTION_PROVIDER_ID });
  const timer = setInterval(() => {
    logger.warn(fields, DEV_SUBSCRIPTION_BANNER);
  }, options.intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
