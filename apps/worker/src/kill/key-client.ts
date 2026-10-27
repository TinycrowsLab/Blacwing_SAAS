import { z } from 'zod';

import { killKeyOutcomeSchema } from '@blackwing/contracts';

import type { KeyControlClient } from './ports.js';

/** The model-gateway endpoint (agreed with MODELGW): `POST <base>/internal/keys:revoke`. */
export const KEYS_REVOKE_PATH = '/internal/keys:revoke';

const ackBodySchema = z.strictObject({
  acks: z.array(z.strictObject({ keyId: z.string().min(1), outcome: killKeyOutcomeSchema })),
});

export interface HttpKeyControlClientOptions {
  /** Base URL of the model gateway internal port. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

/**
 * HTTP adapter for the gateway key-revoke API. Sends opaque virtual key ids only (never a key secret);
 * anything but a well-formed 200 throws, which the stage treats as "not acked" and key expiry backs up.
 */
export function createHttpKeyControlClient(options: HttpKeyControlClientOptions): KeyControlClient {
  const doFetch = options.fetch ?? fetch;
  const url = new URL(KEYS_REVOKE_PATH, options.baseUrl).toString();
  return {
    async revoke(request, signal) {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': request.killEventId },
        body: JSON.stringify({ killEventId: request.killEventId, keyIds: request.keyIds }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`model gateway answered HTTP ${String(response.status)}`);
      }
      return ackBodySchema.parse(await response.json()).acks;
    },
  };
}
