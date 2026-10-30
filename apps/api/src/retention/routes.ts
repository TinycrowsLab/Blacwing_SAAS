import { randomBytes } from 'node:crypto';

import { trace } from '@opentelemetry/api';

import {
  type ErrorEnvironment,
  createProblemDetailsMapper,
  isAppError,
  type ProblemDetailsMapper,
  ValidationError,
} from '@blackwing/errors';

import type { RetentionPrincipal } from './ports.js';
import type { RetentionService } from './service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const RETENTION_POLICIES_ROUTE = '/v1/retention-policies';

const HTTP_OK = 200;
/** W3C trace ids are 16 random bytes. */
const TRACE_ID_BYTES = 16;

/**
 * Authenticates the request (session cookie via BFF, or `bw_pat_`/`bw_ci_` bearer, §9). It throws an
 * `AuthError` for a missing, expired or revoked credential, so the handler never runs for one.
 */
type RetentionAuthenticator = (request: FastifyRequest) => Promise<RetentionPrincipal>;

export interface RetentionRoutesOptions {
  readonly service: RetentionService;
  readonly authenticate: RetentionAuthenticator;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

/** Fastify's body-parser failures (`FST_ERR_CTP_*`: invalid or empty JSON, bad content type). */
function isFastifyBodyError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('FST_ERR_CTP_');
}

function traceIdOf(): string {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx?.traceId ?? randomBytes(TRACE_ID_BYTES).toString('hex');
}

/**
 * Registers `GET` and `PUT /v1/retention-policies` on a Fastify instance. Handlers stay thin:
 * authenticate, hand to the service, answer with the strong ETag. `PUT` requires `If-Match` (428 when
 * absent, 412 when stale). Every failure is RFC 9457 problem+json (§9).
 */
export function registerRetentionRoutes(
  app: FastifyInstance,
  options: RetentionRoutesOptions,
): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );

  void app.register((scope, _opts, done) => {
    scope.setErrorHandler((error: unknown, _request, reply) => {
      const mapped = isAppError(error)
        ? error
        : isFastifyBodyError(error)
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

    scope.get(RETENTION_POLICIES_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const { body, etag } = await options.service.get(principal);
      return reply
        .status(HTTP_OK)
        .header('etag', etag)
        .header('cache-control', 'no-store')
        .send(body);
    });

    scope.put(RETENTION_POLICIES_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const { body, etag } = await options.service.replace(
        principal,
        request.body,
        request.headers['if-match'],
      );
      return reply
        .status(HTTP_OK)
        .header('etag', etag)
        .header('cache-control', 'no-store')
        .send(body);
    });

    done();
  });
}
