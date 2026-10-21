import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';

import { computeEtag } from './etag.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/** Methods whose successful body is a representation of the resource (not DELETE). */
const ETAG_METHODS = new Set(['GET', 'HEAD', 'PATCH', 'PUT', 'POST']);

/**
 * Adds a strong `ETag` to successful responses (GET/HEAD item and list responses, and the body
 * returned by PATCH/PUT so the client has the new validator). Opt in with {@link UseEtag}. Bodies
 * that are not objects, and responses that already set an `ETag`, are left alone.
 */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    if (!ETAG_METHODS.has(request.method)) return next.handle();
    const reply = http.getResponse<FastifyReply>();
    return next.handle().pipe(
      map((body: unknown) => {
        if (typeof body === 'object' && body !== null && !reply.hasHeader('etag')) {
          void reply.header('ETag', computeEtag(body));
        }
        return body;
      }),
    );
  }
}

/** Opt-in per controller or handler: `@UseEtag()` adds `ETag` to its responses. */
export const UseEtag = (): MethodDecorator & ClassDecorator => UseInterceptors(EtagInterceptor);
