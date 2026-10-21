import { z } from 'zod';

import { killEgressIdentitySchema, killEgressOutcomeSchema } from '@blackwing/contracts';

import type { EgressControlClient } from './ports.js';

/** The control endpoint (agreed with EGRESS): `POST <base>/control/kill`. */
export const EGRESS_KILL_PATH = '/control/kill';

const ackBodySchema = z.strictObject({
  acks: z.array(
    z.strictObject({ identity: killEgressIdentitySchema, outcome: killEgressOutcomeSchema }),
  ),
});

export interface HttpEgressControlClientOptions {
  /** Base URL of the gateway admin port (dev: http://localhost:13129). */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

/**
 * HTTP adapter for the gateway control API. It sends opaque identity ids only (no secrets) and parses the
 * reply with Zod; anything but a well-formed 200 throws, which the stage treats as "not acked".
 */
export function createHttpEgressControlClient(
  options: HttpEgressControlClientOptions,
): EgressControlClient {
  const doFetch = options.fetch ?? fetch;
  const url = new URL(EGRESS_KILL_PATH, options.baseUrl).toString();
  return {
    async block(request, signal) {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': request.killEventId },
        body: JSON.stringify({
          killEventId: request.killEventId,
          identities: request.identities,
        }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`egress gateway answered HTTP ${String(response.status)}`);
      }
      return ackBodySchema.parse(await response.json()).acks;
    },
  };
}
