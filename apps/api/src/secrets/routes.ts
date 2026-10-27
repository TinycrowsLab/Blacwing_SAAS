import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import { SECRET_VALUE_MAX_BYTES } from '@blackwing/contracts';
import {
  createProblemDetailsMapper,
  type ErrorEnvironment,
  type ProblemDetailsMapper,
  ValidationError,
} from '@blackwing/errors';

import { SecretApiError } from './errors.js';
import { versionEtag } from '../concurrency/etag.js';
import {
  installProblemHandler,
  translateTransportError,
} from '../errors/scoped-problem-handler.js';
import { IDEMPOTENCY_REPLAYED_HEADER } from '../idempotency/on-send.js';

import type { SecretPrincipal } from './ports.js';
import type { SecretService } from './service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const SECRETS_ROUTE = '/v1/secrets';
export const SECRET_ROUTE = '/v1/secrets/:id';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
/** JSON escaping can inflate a value up to six times (`\u0000` per byte); beyond this it is not a secret. */
const JSON_ESCAPE_FACTOR = 8;
const BODY_LIMIT_BYTES = JSON_ESCAPE_FACTOR * SECRET_VALUE_MAX_BYTES;

/**
 * Authenticates the request (session cookie via BFF, or `bw_pat_`/`bw_ci_` bearer, §9). It must throw an
 * `AuthError` for a missing, expired or revoked credential, so the handler never runs for one. The real
 * guard is the API platform's (#53/#341); the secrets module only consumes the principal.
 */
export type SecretAuthenticator = (request: FastifyRequest) => Promise<SecretPrincipal>;

export interface SecretRoutesOptions {
  readonly service: SecretService;
  readonly authenticate: SecretAuthenticator;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

const idParamsSchema = z.object({ id: z.string() });
const deleteQuerySchema = z.object({ force: z.enum(['true', 'false']).optional() });

/** A body over the route's limit is a too-large secret, not a generic transport error. */
function translate(error: unknown): unknown {
  return (error as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
    ? new SecretApiError(
        'SECRET_TOO_LARGE',
        `a secret value is at most ${String(SECRET_VALUE_MAX_BYTES)} bytes`,
      )
    : translateTransportError(error);
}

/**
 * Registers the write-only secrets API on a Fastify instance (the NestJS Fastify adapter's instance via
 * `createApiApp`'s `routes` hook): `POST/GET /v1/secrets` and `GET/PUT/DELETE /v1/secrets/:id`. Thin
 * handlers: authenticate, hand to the service, answer. Every failure is RFC 9457 problem+json (§9) and
 * every response is `Cache-Control: no-store`.
 */
export function registerSecretRoutes(app: FastifyInstance, options: SecretRoutesOptions): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );

  void app.register((scope, _opts, done) => {
    installProblemHandler(scope, problems, translate);

    const traceId = (): string | null => trace.getActiveSpan()?.spanContext().traceId ?? null;

    scope.post(SECRETS_ROUTE, { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
      const principal = await options.authenticate(request);
      const header = request.headers['idempotency-key'];
      const { response, created } = await options.service.create({
        principal,
        body: request.body,
        idempotencyKey: Array.isArray(header) ? header[0] : header,
        traceId: traceId(),
      });
      void reply
        .status(HTTP_CREATED)
        .header('location', `${SECRETS_ROUTE}/${response.secretId}`)
        .header('etag', versionEtag(response.version))
        .header('cache-control', 'no-store');
      if (!created) void reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      return reply.send(response);
    });

    scope.get(SECRETS_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const page = await options.service.list({
        principal,
        query: z.record(z.string(), z.unknown()).parse(request.query),
        traceId: traceId(),
      });
      return reply.status(HTTP_OK).header('cache-control', 'no-store').send(page);
    });

    scope.get(SECRET_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const secret = await options.service.get({
        principal,
        secretId: idParamsSchema.parse(request.params).id,
        traceId: traceId(),
      });
      return reply
        .status(HTTP_OK)
        .header('etag', versionEtag(secret.currentVersion))
        .header('cache-control', 'no-store')
        .send(secret);
    });

    scope.put(SECRET_ROUTE, { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
      const principal = await options.authenticate(request);
      const { response } = await options.service.update({
        principal,
        secretId: idParamsSchema.parse(request.params).id,
        body: request.body,
        ifMatch: request.headers['if-match'],
        traceId: traceId(),
      });
      return reply
        .status(HTTP_OK)
        .header('etag', versionEtag(response.version))
        .header('cache-control', 'no-store')
        .send(response);
    });

    scope.delete(SECRET_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const query = deleteQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new ValidationError('invalid query', { detail: 'force must be true or false' });
      }
      const secret = await options.service.delete({
        principal,
        secretId: idParamsSchema.parse(request.params).id,
        force: query.data.force === 'true',
        traceId: traceId(),
      });
      return reply
        .status(HTTP_OK)
        .header('etag', versionEtag(secret.currentVersion))
        .header('cache-control', 'no-store')
        .send(secret);
    });

    done();
  });
}
