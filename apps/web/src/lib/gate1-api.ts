import {
  gate1DecisionResponseSchema,
  gate1PlanViewSchema,
  type Gate1DecisionRequest,
  type Gate1DecisionResponse,
  type Gate1PlanView,
} from '@blackwing/contracts';

import { type ApiClient, createApiClient } from './api-client';

/** Query keys of the Gate 1 review. A decision invalidates the plan and the run that it changed. */
export const gate1Keys = {
  plan: (runId: string) => ['gate1', 'plan', runId] as const,
  run: (runId: string) => ['runs', 'detail', runId] as const,
};

export interface Gate1Api {
  plan: (runId: string, signal?: AbortSignal) => Promise<Gate1PlanView>;
  /**
   * `idempotencyKey` belongs to one decision attempt: reuse it when retrying the same decision, so a double
   * submit or a retry after a lost response records the decision once.
   */
  decide: (
    runId: string,
    body: Gate1DecisionRequest,
    idempotencyKey: string,
  ) => Promise<Gate1DecisionResponse>;
}

/** Typed client for the Gate 1 endpoints, through the BFF `/v1` (session cookie, no token in JS). */
export function createGate1Api(client: ApiClient = createApiClient()): Gate1Api {
  return {
    plan: (runId, signal) =>
      client.get(`/runs/${encodeURIComponent(runId)}/gate1`, gate1PlanViewSchema, { signal }),
    decide: (runId, body, idempotencyKey) =>
      client.post(
        `/runs/${encodeURIComponent(runId)}/gate1/decisions`,
        gate1DecisionResponseSchema,
        body,
        { idempotencyKey },
      ),
  };
}
