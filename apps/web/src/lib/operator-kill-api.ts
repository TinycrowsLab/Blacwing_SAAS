import {
  killTriggerResponseSchema,
  operatorBlastRadiusSchema,
  operatorKillEventDetailSchema,
  operatorKillEventListSchema,
  type KillTriggerResponse,
  type OperatorBlastRadius,
  type OperatorKillEventDetail,
  type OperatorKillEventSummary,
  type OperatorKillRequest,
} from '@blackwing/contracts';

import { type ApiClient, createApiClient } from './api-client.js';

/** The operator API lives beside the tenant API, not under `/v1`. */
const OPERATOR_API_BASE_URL = '/operator/v1';

/** Query keys of the operator kill control. */
export const operatorKillKeys = {
  events: ['operator-kill', 'events'] as const,
  event: (id: string) => ['operator-kill', 'event', id] as const,
};

export interface OperatorKillApi {
  blastRadius: (
    scope: OperatorKillRequest['scope'],
    tenantId: string | undefined,
    signal?: AbortSignal,
  ) => Promise<OperatorBlastRadius>;
  /** `idempotencyKey` is reused by a double submit of the same request, so it fires one kill. */
  fire: (request: OperatorKillRequest, idempotencyKey: string) => Promise<KillTriggerResponse>;
  events: (signal?: AbortSignal) => Promise<readonly OperatorKillEventSummary[]>;
  event: (id: string, signal?: AbortSignal) => Promise<OperatorKillEventDetail>;
}

/**
 * Typed client for `/operator/v1/kill`. The platform operator names the tenant explicitly (unlike a
 * tenant user, whose tenant is derived from the session), so `tenantId` travels in the query string
 * of the blast-radius path itself rather than through the client's tenant-parameter guard.
 */
export function createOperatorKillApi(
  client: ApiClient = createApiClient({ baseUrl: OPERATOR_API_BASE_URL }),
): OperatorKillApi {
  return {
    blastRadius: (scope, tenantId, signal) => {
      const query = new URLSearchParams({ scope });
      if (tenantId !== undefined) query.set('tenantId', tenantId);
      return client.get(`/kill/blast-radius?${query.toString()}`, operatorBlastRadiusSchema, {
        signal,
      });
    },
    fire: (request, idempotencyKey) =>
      client.post('/kill', killTriggerResponseSchema, request, { idempotencyKey }),
    events: async (signal) =>
      (await client.get('/kill/events', operatorKillEventListSchema, { signal })).items,
    event: (id, signal) =>
      client.get(`/kill/events/${encodeURIComponent(id)}`, operatorKillEventDetailSchema, {
        signal,
      }),
  };
}
