import { trace } from '@opentelemetry/api';

import {
  createProblemDetailsMapper,
  type ErrorEnvironment,
  type ProblemDetailsMapper,
} from '@blackwing/errors';

import { problemErrorHandler } from '../kill/routes.js';

import type { Gate1Principal } from './ports.js';
import type { Gate1Service } from './service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** `GET /v1/runs/{runId}/gate1`: the plan under review at Gate 1 (#877). */
const GATE1_PLAN_ROUTE = '/v1/runs/:runId/gate1';
/** `POST /v1/runs/{runId}/gate1/decisions`: approve, request changes or reject (#877). */
const GATE1_DECISION_ROUTE = '/v1/runs/:runId/gate1/decisions';

const HTTP_OK = 200;

/**
 * Authenticates the request (session cookie via the BFF, or a `bw_pat_`/`bw_ci_` bearer, §9). It must throw an
 * `AuthError` for a missing, expired or revoked credential, so no handler runs for one.
 */
type Gate1Authenticator = (request: FastifyRequest) => Promise<Gate1Principal>;

export interface Gate1RoutesOptions {
  readonly service: Gate1Service;
  readonly authenticate: Gate1Authenticator;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

/**
 * Registers the Gate 1 routes on a Fastify instance. Handlers are thin: authenticate, hand to the service,
 * answer. Every failure is RFC 9457 problem+json (§9). Responses are `no-store`: they carry the plan and the
 * decision state of one approver.
 */
export function registerGate1Routes(app: FastifyInstance, options: Gate1RoutesOptions): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );

  void app.register((scope, _opts, done) => {
    scope.setErrorHandler(problemErrorHandler(problems));

    scope.get(GATE1_PLAN_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const { runId } = request.params as { runId: string };
      const plan = await options.service.getPlan(principal, runId);
      return reply.status(HTTP_OK).header('cache-control', 'no-store').send(plan);
    });

    scope.post(GATE1_DECISION_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const { runId } = request.params as { runId: string };
      const header = request.headers['idempotency-key'];
      const response = await options.service.decide({
        principal,
        runId,
        body: request.body,
        idempotencyKey: Array.isArray(header) ? header[0] : header,
        traceId: trace.getActiveSpan()?.spanContext().traceId ?? null,
      });
      return reply.status(HTTP_OK).header('cache-control', 'no-store').send(response);
    });

    done();
  });
}
