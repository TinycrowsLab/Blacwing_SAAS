import {
  createProblemDetailsMapper,
  type ErrorEnvironment,
  type ProblemDetailsMapper,
} from '@blackwing/errors';

import { problemErrorHandler } from '../kill/routes.js';

import type { SurfacePrincipal } from './ports.js';
import type { SurfaceService } from './service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** `GET /v1/runs/{runId}/surface`: the bounded console view of one run's surface graph (GRAPH-006). */
export const RUN_SURFACE_ROUTE = '/v1/runs/:runId/surface';

const HTTP_OK = 200;

/**
 * Authenticates the request (session cookie via BFF, or `bw_pat_`/`bw_ci_` bearer, §9). It must throw an `AuthError`
 * for a missing, expired or revoked credential, so the handler never runs for one.
 */
export type SurfaceAuthenticator = (request: FastifyRequest) => Promise<SurfacePrincipal>;

export interface RunSurfaceRoutesOptions {
  readonly service: SurfaceService;
  readonly authenticate: SurfaceAuthenticator;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

/**
 * Registers `GET /v1/runs/:runId/surface`. Thin: authenticate, hand to the service, answer with `no-store`. Every
 * refusal is RFC 9457 problem+json (§9), mapped by the same handler the other `/v1` modules use.
 */
export function registerRunSurfaceRoutes(
  app: FastifyInstance,
  options: RunSurfaceRoutesOptions,
): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );

  void app.register((scope, _opts, done) => {
    scope.setErrorHandler(problemErrorHandler(problems));

    scope.get(RUN_SURFACE_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const { runId } = request.params as { runId: string };
      const view = await options.service.get(
        principal,
        runId,
        request.query as Readonly<Record<string, unknown>>,
      );
      return reply.status(HTTP_OK).header('cache-control', 'no-store').send(view);
    });

    done();
  });
}
