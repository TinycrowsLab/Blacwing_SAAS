import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import { LIMITS, uuidV7Schema } from '@blackwing/contracts';
import {
  createProblemDetailsMapper,
  type ErrorEnvironment,
  NotFoundError,
  type ProblemDetailsMapper,
  ValidationError,
} from '@blackwing/errors';

import { type KillAuthenticator, problemErrorHandler } from '../kill/routes.js';

import type { SocKillService } from './service.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

const SOC_KILL_PAGE_ROUTE = '/soc/kill/:token';
const SOC_KILL_TRIGGER_ROUTE = '/soc/kill';
const SOC_KILL_MINT_ROUTE = '/v1/assets/:id/soc-kill-link';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_ACCEPTED = 202;
/** A kill link is ~450 characters; anything much longer cannot be one. */
const TOKEN_MAX = 1024;

export interface SocKillRoutesOptions {
  readonly service: SocKillService;
  /** Authenticates the mint endpoint only; the two SOC routes are public by design. */
  readonly authenticate: KillAuthenticator;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

const triggerBodySchema = z.strictObject({ token: z.string().min(1).max(TOKEN_MAX) });
const mintParamsSchema = z.strictObject({ id: uuidV7Schema });
const mintBodySchema = z.strictObject({
  contactId: uuidV7Schema.optional(),
  maxUses: z.int().min(1).max(LIMITS.killTokenUsesMax).optional(),
  expiresAt: z.iso.datetime().optional(),
});

/** The link is a credential: nothing may cache it or leak it through a referrer. */
function secretHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex, nofollow');
}

/**
 * Registers the SOC kill link routes (KILL-007): `POST /v1/assets/:id/soc-kill-link` (authenticated),
 * and the public, login-free `GET /soc/kill/:token` and `POST /soc/kill`. The public routes answer a
 * refusal with one generic 404 and a rate-limited caller with 429 + `Retry-After`.
 */
export function registerSocKillRoutes(app: FastifyInstance, options: SocKillRoutesOptions): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );
  const traceId = (): string | null => trace.getActiveSpan()?.spanContext().traceId ?? null;

  void app.register((scope, _opts, done) => {
    scope.setErrorHandler(problemErrorHandler(problems));

    scope.post(SOC_KILL_MINT_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const params = mintParamsSchema.safeParse(request.params);
      if (!params.success) throw new NotFoundError('asset not found');
      const body = mintBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        const fields = [...new Set(body.error.issues.map((i) => i.path.join('.') || '(body)'))];
        throw new ValidationError('invalid kill link request', {
          detail: `invalid fields: ${fields.join(', ')}`,
        });
      }
      const minted = await options.service.mint({
        principal,
        scope: 'asset',
        scopeRefId: params.data.id,
        traceId: traceId(),
        ...(body.data.contactId === undefined ? {} : { contactId: body.data.contactId }),
        ...(body.data.maxUses === undefined ? {} : { maxUses: body.data.maxUses }),
        ...(body.data.expiresAt === undefined ? {} : { expiresAt: new Date(body.data.expiresAt) }),
      });
      return secretHeaders(reply).status(HTTP_CREATED).send(minted);
    });

    scope.get<{ Params: { token: string } }>(SOC_KILL_PAGE_ROUTE, async (request, reply) => {
      const preview = await options.service.preview(request.params.token, request.ip);
      return secretHeaders(reply).status(HTTP_OK).send(preview);
    });

    scope.post(SOC_KILL_TRIGGER_ROUTE, async (request, reply) => {
      const body = triggerBodySchema.safeParse(request.body);
      if (!body.success) throw new ValidationError('request body must be { token }');
      const response = await options.service.trigger(body.data.token, request.ip, traceId());
      return secretHeaders(reply).status(HTTP_ACCEPTED).send(response);
    });

    done();
  });
}
