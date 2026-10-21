import { requestContext } from '@fastify/request-context';
import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { defer, mergeMap, type Observable, of, throwError } from 'rxjs';

import { TenantContextMissingError } from '@blackwing/errors';

import { setIdempotencyState } from './on-send.js';
import { requestLogger } from '../bootstrap/request-context.js';
import { API_LOGGER } from '../bootstrap/tokens.js';

import type { IdempotencyService } from './service.js';
import type { Logger } from '@blackwing/logger';
import type { FastifyRequest } from 'fastify';

/** DI token of the {@link IdempotencyService} (provided by `IdempotencyModule`). */
export const IDEMPOTENCY_SERVICE = Symbol.for('blackwing.api.idempotency.service');

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer | string };

/**
 * Enforces `Idempotency-Key` on the routes it decorates (API-008). Before the handler: tenant check
 * (fail closed), key validation, then the store decides between running the handler, replaying the
 * stored response or refusing (409/503). The result is stored by the `onSend` hook
 * (`registerIdempotencyHook`) when the response is written.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY_SERVICE) private readonly service: IdempotencyService,
    @Inject(API_LOGGER) private readonly logger: Logger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<RawBodyRequest>();
    // §8.6: the tenant is part of the key. Without one the request is refused, never keyed globally.
    const tenantId = requestContext.get('tenantId');
    if (tenantId === undefined)
      return throwError(
        () => new TenantContextMissingError('Idempotency-Key handling needs a tenant context'),
      );

    const { path, query } = splitUrl(request.url);
    return defer(() =>
      this.service.begin({
        tenantId,
        route: request.routeOptions.url ?? path,
        method: request.method,
        path,
        query,
        key: request.headers['idempotency-key'],
        rawBody: request.rawBody,
        logger: requestLogger(this.logger),
      }),
    ).pipe(
      mergeMap((outcome) => {
        if (outcome.kind === 'replay') {
          setIdempotencyState(request, { kind: 'replay', result: outcome.result });
          // The handler is skipped; the onSend hook writes the stored response over this placeholder.
          return of('');
        }
        setIdempotencyState(request, { kind: 'pending', pending: outcome.pending });
        return next.handle();
      }),
    );
  }
}

function splitUrl(url: string): { readonly path: string; readonly query: string } {
  const index = url.indexOf('?');
  return index === -1
    ? { path: url, query: '' }
    : { path: url.slice(0, index), query: url.slice(index + 1) };
}

/**
 * Marks a route as requiring `Idempotency-Key`: a missing header is `400 idempotency_key_required`, a
 * repeated key replays the first response. Put it on POST handlers that create runs, exports or tickets.
 */
export const Idempotent = (): MethodDecorator & ClassDecorator =>
  applyDecorators(UseInterceptors(IdempotencyInterceptor));
