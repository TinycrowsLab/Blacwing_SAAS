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

import { computeEtag } from '../concurrency/etag.js';
import { requireIfMatch } from '../concurrency/if-match.js';

import type { OncallPrincipal } from './ports.js';
import type { OncallService } from './service.js';
import type { OncallRoster } from '@blackwing/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const ONCALL_ROSTERS_ROUTE = '/v1/oncall/rosters';
export const ONCALL_ROSTER_ROUTE = '/v1/oncall/rosters/:id';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
/** W3C trace ids are 16 random bytes. */
const TRACE_ID_BYTES = 16;

/**
 * Authenticates the request (session cookie via BFF, or `bw_pat_` bearer, §9). It must throw an
 * `AuthError` for a missing, expired or revoked credential, so the handler never runs for one. The
 * real guard is the API platform's; the on-call module only consumes the principal.
 */
export type OncallAuthenticator = (request: FastifyRequest) => Promise<OncallPrincipal>;

export interface OncallRoutesOptions {
  readonly service: OncallService;
  readonly authenticate: OncallAuthenticator;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

const idParamsSchema = z.strictObject({ id: uuidV7Schema });

function traceIdOf(): string {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx?.traceId ?? randomBytes(TRACE_ID_BYTES).toString('hex');
}

function send(reply: FastifyReply, status: number, roster: OncallRoster) {
  return reply
    .status(status)
    .header('etag', computeEtag(roster))
    .header('cache-control', 'no-store')
    .send(roster);
}

/**
 * Registers the roster management routes on a Fastify instance (the NestJS Fastify adapter's
 * instance once mounted): `GET/POST /v1/oncall/rosters` and `GET/PATCH /v1/oncall/rosters/:id`.
 * Thin handlers: authenticate, hand to the service, answer. Every failure is RFC 9457 problem+json.
 */
export function registerOncallRoutes(app: FastifyInstance, options: OncallRoutesOptions): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );

  void app.register((scope, _opts, done) => {
    scope.setErrorHandler((error: unknown, _request, reply) => {
      const code = (error as { code?: unknown }).code;
      const mapped = isAppError(error)
        ? error
        : code === 'FST_ERR_CTP_INVALID_JSON' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
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

    const idOf = (request: FastifyRequest): string => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) throw new NotFoundError('on-call roster not found');
      return params.data.id;
    };
    const traceOf = (): string | null => trace.getActiveSpan()?.spanContext().traceId ?? null;

    scope.get(ONCALL_ROSTERS_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const items = await options.service.listRosters(principal);
      return reply
        .status(HTTP_OK)
        .header('cache-control', 'no-store')
        .send({ items, nextCursor: null });
    });

    scope.post(ONCALL_ROSTERS_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const roster = await options.service.createRoster(principal, request.body, traceOf());
      void reply.header('location', `${ONCALL_ROSTERS_ROUTE}/${roster.id}`);
      return send(reply, HTTP_CREATED, roster);
    });

    scope.get(ONCALL_ROSTER_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      return send(reply, HTTP_OK, await options.service.getRoster(principal, idOf(request)));
    });

    scope.patch(ONCALL_ROSTER_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const id = idOf(request);
      const current = await options.service.getRoster(principal, id);
      // 428 without If-Match, 412 for a stale ETag; the store's compare-and-set is the final word.
      const precondition = requireIfMatch(computeEtag(current), request.headers['if-match']);
      const updated = await options.service.updateRoster(
        principal,
        id,
        request.body,
        precondition.expectedVersion ?? current.stateVersion,
        traceOf(),
      );
      return send(reply, HTTP_OK, updated);
    });

    done();
  });
}
