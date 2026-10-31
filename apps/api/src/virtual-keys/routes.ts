// Internal virtual-key endpoints (GATEWAY-002, #405): `POST /internal/keys:mint`, `:revoke` and `:validate`.
// They are for the Run Broker and the kill coordinator only and are never public. Every request must pass the
// source guard (peer CIDR and mesh identity, fail closed) before its body is read. The mint endpoint is rate
// limited per tenant. A refused key is one uniform 401 that never says which check failed.

import {
  AuthError,
  createProblemDetailsMapper,
  ForbiddenError,
  InternalError,
  isAppError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '@blackwing/errors';

import type { VirtualKeyMetrics } from './metrics.js';
import type { VirtualKeyService } from './service.js';
import type { SourceGuard } from '../broker/network.js';
import type { Logger } from '@blackwing/logger';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const VKEY_MINT_ROUTE = '/internal/keys:mint';
export const VKEY_REVOKE_ROUTE = '/internal/keys:revoke';
export const VKEY_VALIDATE_ROUTE = '/internal/keys:validate';
/**
 * One route serves the three actions: find-my-way reads a `:` after a static segment as a parameter, so the three
 * literal paths cannot be registered side by side. The parameter keeps its colon (`:mint`), and anything else 404s.
 */
const VKEY_ACTION_ROUTE = '/internal/keys:action';

const HTTP_STATUS_CREATED = 201;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_INTERNAL = 500;
const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_TENANTS = 10_000;
const GENERIC_FORBIDDEN = 'This request is not permitted from this source.';
const GENERIC_UNAUTHORIZED = 'The virtual key is not valid.';

export interface VirtualKeyRoutesOptions {
  readonly service: VirtualKeyService;
  readonly sourceGuard: SourceGuard;
  readonly metrics: VirtualKeyMetrics;
  readonly logger: Logger;
  /** Header the mesh sets to the caller's identity (checked by the source guard). */
  readonly identityHeader: string;
  readonly mintRateLimitPerMinute: number;
  readonly now?: () => number;
}

/** Fixed-window counter per tenant, bounded in size. Per process: replicas each enforce their own window. */
function createMintLimiter(limit: number, now: () => number): (key: string) => number | null {
  const windows = new Map<string, { start: number; count: number }>();
  return (key) => {
    const current = now();
    const entry = windows.get(key);
    if (entry === undefined || current - entry.start >= RATE_WINDOW_MS) {
      if (windows.size >= MAX_TRACKED_TENANTS) windows.clear();
      windows.set(key, { start: current, count: 1 });
      return null;
    }
    if (entry.count >= limit)
      return Math.ceil((entry.start + RATE_WINDOW_MS - current) / MS_PER_SECOND);
    entry.count += 1;
    return null;
  };
}

const HTTP_STATUS_CLIENT_ERROR_MIN = 400;
const MS_PER_SECOND = 1000;

/**
 * Maps a thrown value to an AppError. A Fastify client error (bad JSON, body too large) is a validation
 * failure; anything else is an internal error with no detail reaching the caller.
 */
function toAppError(error: unknown): unknown {
  if (isAppError(error)) return error;
  const { statusCode } = error as { statusCode?: unknown };
  if (
    typeof statusCode === 'number' &&
    statusCode >= HTTP_STATUS_CLIENT_ERROR_MIN &&
    statusCode < HTTP_STATUS_INTERNAL
  ) {
    return new ValidationError('request is invalid', { cause: error });
  }
  return new InternalError('internal error', { cause: error });
}

function callerIdentity(request: FastifyRequest, header: string): string {
  const value = request.headers[header];
  return typeof value === 'string' ? value : 'unknown';
}

export function registerVirtualKeyRoutes(
  app: FastifyInstance,
  options: VirtualKeyRoutesOptions,
): void {
  const problems = createProblemDetailsMapper({});
  const now = options.now ?? Date.now;
  const takeMint = createMintLimiter(options.mintRateLimitPerMinute, now);
  const { service, metrics, logger } = options;

  void app.register((scope, _opts, done) => {
    scope.setErrorHandler((error: unknown, request, reply) => {
      const mapped = toAppError(error);
      if (!isAppError(mapped) || mapped.httpStatus >= HTTP_STATUS_INTERNAL) {
        logger.error(
          { event: 'vkey.request_failed', route: request.url },
          'virtual key request failed',
        );
      }
      const response = problems.toProblemResponse(mapped, request.id);
      const headers: Record<string, string> = { ...response.headers, 'cache-control': 'no-store' };
      void reply.status(response.status).headers(headers).send(response.body);
    });

    scope.setNotFoundHandler(() => {
      throw new NotFoundError('not found');
    });

    scope.addHook('onRequest', (request, _reply, done) => {
      const refusal = options.sourceGuard.check({
        remoteAddress: request.socket.remoteAddress,
        headers: request.headers,
      });
      if (refusal === null) {
        done();
        return;
      }
      metrics.authFailures.inc({ reason: `source_${refusal}` });
      logger.warn({ event: 'vkey.source_refused', reason: refusal }, 'virtual key request refused');
      done(new ForbiddenError('source not permitted', { detail: GENERIC_FORBIDDEN }));
    });

    const mint = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const body = request.body as { tenantId?: unknown } | undefined;
      const tenantKey = typeof body?.tenantId === 'string' ? body.tenantId : 'unknown';
      const retryAfter = takeMint(tenantKey);
      if (retryAfter !== null) {
        throw new RateLimitedError('virtual key mint rate limit exceeded', {
          retryAfterSeconds: retryAfter,
        });
      }
      const response = await service.mint(request.body, {
        identity: callerIdentity(request, options.identityHeader),
      });
      return reply.code(HTTP_STATUS_CREATED).header('cache-control', 'no-store').send(response);
    };

    const revoke = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const response = await service.revoke(request.body, {
        identity: callerIdentity(request, options.identityHeader),
      });
      return reply.code(HTTP_STATUS_OK).send(response);
    };

    const validate = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const body = request.body as { key?: unknown } | undefined;
      const key = typeof body?.key === 'string' ? body.key : '';
      const context = await service.authenticate(key);
      if (context === undefined) {
        metrics.authFailures.inc({ reason: 'key_rejected' });
        throw new AuthError(GENERIC_UNAUTHORIZED);
      }
      return reply.code(HTTP_STATUS_OK).header('cache-control', 'no-store').send(context);
    };

    const actions: Readonly<
      Record<string, (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>>
    > = {
      ':mint': mint,
      ':revoke': revoke,
      ':validate': validate,
    };

    scope.post(VKEY_ACTION_ROUTE, (request, reply) => {
      const { action } = request.params as { action: string };
      const handler = Object.hasOwn(actions, action) ? actions[action] : undefined;
      if (handler === undefined) throw new NotFoundError('not found');
      return handler(request, reply);
    });

    done();
  });
}
