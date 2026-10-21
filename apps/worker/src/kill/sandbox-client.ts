import { z } from 'zod';

import { killSandboxOutcomeSchema } from '@blackwing/contracts';

import type { SandboxControlClient } from './ports.js';

/** The controller endpoint (agreed with SANDBOX): `POST <base>/sandboxes:terminate`. */
export const SANDBOX_TERMINATE_PATH = '/sandboxes:terminate';

const ackBodySchema = z.strictObject({
  acks: z.array(
    z.strictObject({ sandboxId: z.string().min(1), outcome: killSandboxOutcomeSchema }),
  ),
});

export interface HttpSandboxControlClientOptions {
  /** Base URL of the sandbox-controller (dev: http://localhost:13700). */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

/**
 * HTTP adapter for the controller terminate API. Sends opaque sandbox ids and `force: true` (immediate
 * kill, no drain); anything but a well-formed 200 throws, which the stage treats as "not acked".
 */
export function createHttpSandboxControlClient(
  options: HttpSandboxControlClientOptions,
): SandboxControlClient {
  const doFetch = options.fetch ?? fetch;
  const url = new URL(SANDBOX_TERMINATE_PATH, options.baseUrl).toString();
  return {
    async terminate(request, signal) {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': request.killEventId },
        body: JSON.stringify({
          killEventId: request.killEventId,
          sandboxIds: request.sandboxIds,
          force: true,
        }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`sandbox controller answered HTTP ${String(response.status)}`);
      }
      return ackBodySchema.parse(await response.json()).acks;
    },
  };
}

/** Parses `KILL_SANDBOX_DEADLINE_MS`; anything missing or not a positive integer falls back. */
export function sandboxDeadlineFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
