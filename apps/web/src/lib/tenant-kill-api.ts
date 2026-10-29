import {
  killEventListSchema,
  killEventViewSchema,
  killTriggerResponseSchema,
  type KillApiScope,
  type KillEventView,
  type KillTriggerResponse,
} from '@blackwing/contracts';

import { createApiClient, type ApiClient } from './api-client';

/** Query keys of the tenant kill control (the console's `/v1/kill` family). */
export const tenantKillKeys = {
  events: ['kill', 'events'] as const,
  event: (id: string) => ['kill', 'event', id] as const,
};

/** Body of `POST /v1/kill`: `scopeRefId` names the run or asset, and is absent for a tenant kill. */
interface TenantKillRequest {
  readonly scope: KillApiScope;
  readonly scopeRefId?: string | undefined;
  readonly reason: string;
}

export interface TenantKillApi {
  /** `idempotencyKey` is reused by a double submit of the same request, so it fires one kill (§9). */
  fire: (request: TenantKillRequest, idempotencyKey: string) => Promise<KillTriggerResponse>;
  event: (id: string, signal?: AbortSignal) => Promise<KillEventView>;
  events: (signal?: AbortSignal) => Promise<readonly KillEventView[]>;
}

/**
 * Typed client for the tenant kill API (F33, §8.5). The tenant is derived from the session on the
 * server, so the client never sends one (`/v1` through the BFF).
 */
export function createTenantKillApi(client: ApiClient = createApiClient()): TenantKillApi {
  return {
    fire: (request, idempotencyKey) => {
      const body = {
        scope: request.scope,
        ...(request.scopeRefId === undefined ? {} : { scopeRefId: request.scopeRefId }),
        reason: request.reason.trim(),
      };
      return client.post('/kill', killTriggerResponseSchema, body, { idempotencyKey });
    },
    event: (id, signal) =>
      client.get(`/kill/${encodeURIComponent(id)}`, killEventViewSchema, { signal }),
    events: async (signal) => (await client.get('/kill', killEventListSchema, { signal })).items,
  };
}
