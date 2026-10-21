import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';

import { runWithTenantContext } from '@blackwing/db/tenant-context';
import { TenantContextMissingError } from '@blackwing/errors';

import { tenantContextOf } from './guard.js';
import { PUBLIC_ROUTE_KEY } from './public-route.js';

import type { FastifyRequest } from 'fastify';

/**
 * Opens the `AsyncLocalStorage` scope (`runWithTenantContext`) around the handler, so repositories read
 * the tenant of exactly this request. The handler starts inside the scope (on subscribe), and every
 * continuation it spawns inherits it. A non-public route that reaches here without a guard-resolved
 * context is refused (fail closed).
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return next.handle();
    const tenant =
      context.getType() === 'http'
        ? tenantContextOf(context.switchToHttp().getRequest<FastifyRequest>())
        : undefined;
    if (tenant === undefined) {
      throw new TenantContextMissingError('tenant context was not resolved before the handler');
    }
    return new Observable((subscriber) => {
      const subscription = runWithTenantContext(tenant, () => next.handle().subscribe(subscriber));
      return () => {
        subscription.unsubscribe();
      };
    });
  }
}
