import { trace } from '@opentelemetry/api';

import {
  createProblemDetailsMapper,
  type ErrorEnvironment,
  type ProblemDetailsMapper,
} from '@blackwing/errors';

import { useProblemErrorHandler } from '../kill/routes.js';

import type { OperatorPrincipal } from './ports.js';
import type { OperatorKillService } from './service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const OPERATOR_KILL_ROUTE = '/operator/v1/kill';
export const OPERATOR_BLAST_RADIUS_ROUTE = `${OPERATOR_KILL_ROUTE}/blast-radius`;
export const OPERATOR_KILL_EVENTS_ROUTE = `${OPERATOR_KILL_ROUTE}/events`;
export const OPERATOR_KILL_EVENT_ROUTE = `${OPERATOR_KILL_EVENTS_ROUTE}/:id`;

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;

/**
 * Authenticates an operator request (the platform-operator session, #838). It must throw an
 * `AuthError` for a missing, expired or revoked credential. It may return a principal that is not a
 * platform operator (a tenant session); the service then refuses it with `NOT_OPERATOR`.
 */
export type OperatorKillAuthenticator = (request: FastifyRequest) => Promise<OperatorPrincipal>;

export interface OperatorKillRoutesOptions {
  readonly service: OperatorKillService;
  readonly authenticate: OperatorKillAuthenticator;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

const traceIdNow = (): string | null => trace.getActiveSpan()?.spanContext().traceId ?? null;

/**
 * Registers the operator kill endpoints on a Fastify instance. Thin handlers: authenticate, hand to
 * the service, answer; every failure is RFC 9457 problem+json (§9) and nothing is cached.
 */
export function registerOperatorKillRoutes(
  app: FastifyInstance,
  options: OperatorKillRoutesOptions,
): void {
  const { service, authenticate } = options;
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );

  void app.register((scope, _opts, done) => {
    useProblemErrorHandler(scope, problems);

    scope.get(OPERATOR_BLAST_RADIUS_ROUTE, async (request, reply) => {
      const principal = await authenticate(request);
      const radius = await service.preview(principal, request.query, traceIdNow());
      return reply.status(HTTP_OK).header('cache-control', 'no-store').send(radius);
    });

    scope.post(OPERATOR_KILL_ROUTE, async (request, reply) => {
      const principal = await authenticate(request);
      const header = request.headers['idempotency-key'];
      const response = await service.fire({
        principal,
        body: request.body,
        idempotencyKey: Array.isArray(header) ? header[0] : header,
        traceId: traceIdNow(),
      });
      return reply
        .status(HTTP_ACCEPTED)
        .header('location', `${OPERATOR_KILL_EVENTS_ROUTE}/${response.killEventId}`)
        .header('cache-control', 'no-store')
        .send(response);
    });

    scope.get(OPERATOR_KILL_EVENTS_ROUTE, async (request, reply) => {
      const principal = await authenticate(request);
      const items = await service.list(principal);
      return reply.status(HTTP_OK).header('cache-control', 'no-store').send({ items });
    });

    scope.get<{ Params: { id: string } }>(OPERATOR_KILL_EVENT_ROUTE, async (request, reply) => {
      const principal = await authenticate(request);
      const event = await service.get(principal, request.params.id);
      return reply.status(HTTP_OK).header('cache-control', 'no-store').send(event);
    });

    done();
  });
}
