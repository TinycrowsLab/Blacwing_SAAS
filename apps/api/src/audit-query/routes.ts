import {
  createProblemDetailsMapper,
  type ErrorEnvironment,
  type ProblemDetailsMapper,
} from '@blackwing/errors';

import { useProblemErrorHandler } from '../kill/routes.js';

import type { AuditQueryPrincipal } from './ports.js';
import type { AuditEventsPage, AuditQueryService } from './service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const AUDIT_EVENTS_ROUTE = '/v1/audit/events';

const HTTP_OK = 200;

/**
 * Authenticates the request (session cookie via BFF, or `bw_pat_`/`bw_ci_` bearer, §9). It must throw an
 * `AuthError` for a missing, expired or revoked credential, so the handler never runs for one.
 */
export type AuditQueryAuthenticator = (request: FastifyRequest) => Promise<AuditQueryPrincipal>;

export interface AuditQueryRoutesOptions {
  readonly service: Pick<AuditQueryService, 'list'>;
  readonly authenticate: AuditQueryAuthenticator;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

/**
 * Registers `GET /v1/audit/events` on a Fastify instance. Thin: authenticate, hand the raw query to the
 * service, answer. Every failure is RFC 9457 problem+json (§9).
 */
export function registerAuditQueryRoutes(
  app: FastifyInstance,
  options: AuditQueryRoutesOptions,
): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );

  void app.register((scope, _opts, done) => {
    useProblemErrorHandler(scope, problems);
    scope.get(AUDIT_EVENTS_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const page: AuditEventsPage = await options.service.list(principal, request.query);
      return reply.status(HTTP_OK).header('cache-control', 'no-store').send(page);
    });
    done();
  });
}
