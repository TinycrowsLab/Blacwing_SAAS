import { proxyActivities, sleep } from '@temporalio/workflow';

import { runSaExpiry } from '../sa-expiry/sequence.js';

import type { SaExpiryActivities, SaExpiryInput, SaExpiryOutcome } from '../sa-expiry/types.js';

const acts = proxyActivities<SaExpiryActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '200 milliseconds', backoffCoefficient: 2, maximumAttempts: 6 },
});

/**
 * AUTHZ-010: expires one standing authorisation at its `expires_at`. Started once per SA on activation (the
 * workflow id is `sa-expiry:<tenant>:<sa>`, so a refresh of an already running one is a no-op). The sweep
 * inside {@link runSaExpiry} is the source of truth; its durable timers only shorten the wait.
 */
export async function SaExpiryWorkflow(input: SaExpiryInput): Promise<SaExpiryOutcome['kind']> {
  return runSaExpiry(input, acts, { sleep: async (ms) => sleep(ms) });
}
