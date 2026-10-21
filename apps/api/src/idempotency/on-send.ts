import { REPLAYED_HEADERS } from './snapshot.js';

import type { StoredResult } from './record.js';
import type { IdempotencyService, PendingExecution } from './service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** What the interceptor decided for a request, picked up by the `onSend` hook that writes the response. */
export type RequestIdempotencyState =
  | { readonly kind: 'pending'; readonly pending: PendingExecution }
  | { readonly kind: 'replay'; readonly result: StoredResult };

const states = new WeakMap<FastifyRequest, RequestIdempotencyState>();

/** Records the interceptor's decision for `request`. */
export function setIdempotencyState(request: FastifyRequest, state: RequestIdempotencyState): void {
  states.set(request, state);
}

/** Header telling the client the response is the stored result of an earlier request (API-008). */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/**
 * Installs the `onSend` hook that finishes idempotent requests in the same path as the response:
 *
 * - replay: the stored status, header subset and body replace whatever the (skipped) handler produced,
 *   byte for byte, plus `Idempotency-Replayed: true`;
 * - first execution: the status, headers and body about to be written are what get stored. Reading them
 *   here, after serialization and after the exception filter, means error responses are stored exactly
 *   as the client saw them and the stored copy cannot drift from the real response.
 *
 * Must run before the app initialises so the hook covers every route.
 */
export function registerIdempotencyHook(app: FastifyInstance, service: IdempotencyService): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const state = states.get(request);
    if (state === undefined) return payload;
    states.delete(request);

    if (state.kind === 'replay') {
      for (const name of REPLAYED_HEADERS) void reply.removeHeader(name);
      void reply.code(state.result.status);
      for (const [name, value] of Object.entries(state.result.headers))
        void reply.header(name, value);
      void reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      return state.result.body;
    }
    await service.finish(state.pending, {
      status: reply.statusCode,
      headers: reply.getHeaders(),
      payload,
    });
    return payload;
  });
}
