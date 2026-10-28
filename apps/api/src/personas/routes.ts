import {
  createProblemDetailsMapper,
  type ErrorEnvironment,
  type ProblemDetailsMapper,
} from '@blackwing/errors';

import { problemErrorHandler } from '../kill/routes.js';

import type { PersonaPrincipal } from './ports.js';
import type { PersonaOverrideService } from './service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const PERSONA_OVERRIDE_ROUTE = '/v1/personas/:persona/override';

const HTTP_OK = 200;

/**
 * Authenticates the request (session cookie via BFF, or `bw_pat_`/`bw_ci_` bearer, §9). It must throw an
 * `AuthError` for a missing, expired or revoked credential, so the handler never runs for one. The real
 * guard is the API platform's; this module only consumes the principal.
 */
export type PersonaAuthenticator = (request: FastifyRequest) => Promise<PersonaPrincipal>;

export interface PersonaRoutesOptions<Tx> {
  readonly service: PersonaOverrideService<Tx>;
  readonly authenticate: PersonaAuthenticator;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

/**
 * Registers `GET` and `PUT /v1/personas/:persona/override` on a Fastify instance. Thin handlers:
 * authenticate, hand to the service, answer. The body is the whole override (a PUT replaces it); every
 * failure is RFC 9457 problem+json (§9).
 */
export function registerPersonaRoutes<Tx>(
  app: FastifyInstance,
  options: PersonaRoutesOptions<Tx>,
): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );

  void app.register((scope, _opts, done) => {
    scope.setErrorHandler(problemErrorHandler(problems));

    scope.get(PERSONA_OVERRIDE_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const { persona } = request.params as { persona: string };
      const view = await options.service.get(principal, persona);
      return reply.status(HTTP_OK).header('cache-control', 'no-store').send(view);
    });

    scope.put(PERSONA_OVERRIDE_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const { persona } = request.params as { persona: string };
      const view = await options.service.put(principal, persona, request.body);
      return reply.status(HTTP_OK).header('cache-control', 'no-store').send(view);
    });

    done();
  });
}
