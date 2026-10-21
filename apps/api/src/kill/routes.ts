import { randomBytes } from 'node:crypto';

import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import { uuidV7Schema } from '@blackwing/contracts';
import {
  type ErrorEnvironment,
  isAppError,
  NotFoundError,
  type ProblemDetailsMapper,
  createProblemDetailsMapper,
  ValidationError,
} from '@blackwing/errors';

import type { KillPrincipal } from './ports.js';
import type { KillService } from './service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const KILL_ROUTE = '/v1/kill';

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
/** W3C trace ids are 16 random bytes. */
const TRACE_ID_BYTES = 16;
export const KILL_EVENT_ROUTE = '/v1/kill/:id';

/**
 * Authenticates the request (session cookie via BFF, or `bw_pat_`/`bw_ci_` bearer, §9). It must throw
 * an `AuthError` for a missing, expired or revoked credential, so the handler never runs for one.
 * The real guard is the API platform's (#53/#341); the kill module only consumes the principal.
 */
export type KillAuthenticator = (request: FastifyRequest) => Promise<KillPrincipal>;

export interface KillRoutesOptions {
  readonly service: KillService;
  readonly authenticate: KillAuthenticator;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

const idParamsSchema = z.strictObject({ id: uuidV7Schema });

function traceIdOf(): string {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx?.traceId ?? randomBytes(TRACE_ID_BYTES).toString('hex');
}

/**
 * Registers `POST /v1/kill` and `GET /v1/kill/:id` on a Fastify instance (the NestJS Fastify adapter's
 * instance once the API bootstrap lands, #53). Thin handlers: authenticate, hand to the service,
 * answer. Every failure is RFC 9457 problem+json (§9).
 */
export function registerKillRoutes(app: FastifyInstance, options: KillRoutesOptions): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );

  void app.register((scope, _opts, done) => {
    scope.setErrorHandler((error: unknown, _request, reply) => {
      const mapped = isAppError(error)
        ? error
        : (error as { code?: unknown }).code === 'FST_ERR_CTP_INVALID_JSON' ||
            (error as { code?: unknown }).code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
          ? new ValidationError('request body is not valid JSON', {
              detail: 'request body is not valid JSON',
            })
          : error;
      const response = problems.toProblemResponse(mapped, traceIdOf());
      void reply
        .status(response.status)
        .headers({ ...response.headers })
        .send(response.body);
    });

    scope.post(KILL_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const header = request.headers['idempotency-key'];
      const { response } = await options.service.trigger({
        principal,
        body: request.body,
        idempotencyKey: Array.isArray(header) ? header[0] : header,
        traceId: trace.getActiveSpan()?.spanContext().traceId ?? null,
      });
      return reply
        .status(HTTP_ACCEPTED)
        .header('location', `${KILL_ROUTE}/${response.killEventId}`)
        .header('cache-control', 'no-store')
        .send(response);
    });

    scope.get(KILL_EVENT_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) throw new NotFoundError('kill event not found');
      const event = await options.service.getView(principal, params.data.id);
      const { id, ...rest } = event;
      return reply
        .status(HTTP_OK)
        .header('cache-control', 'no-store')
        .send({ killEventId: id, ...rest });
    });

    done();
  });
}
