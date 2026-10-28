import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  resolveTenantContext,
  type TenantContext,
  type TenantContextMetrics,
  type TenantPrincipal,
} from '@blackwing/db/tenant-context';
import { AuthError, TenantContextMissingError } from '@blackwing/errors';

import { PUBLIC_ROUTE_KEY } from './public-route.js';
import { bindTenant } from '../bootstrap/request-context.js';
import { API_TENANT_METRICS, API_TENANT_PRINCIPAL_SOURCE } from '../bootstrap/tokens.js';
import { requestOf } from '../bootstrap/transport.js';

import type { FastifyRequest } from 'fastify';

/**
 * Returns the principal IAM already validated for this request (session via the BFF, or a `bw_pat_` /
 * `bw_ci_` bearer), or `null` when there is none. It must never read a tenant from the body, a query
 * parameter or an unvalidated token: the tenant fields it fills come from validated sources only.
 */
export type TenantPrincipalSource = (
  request: FastifyRequest,
) => TenantPrincipal | null | Promise<TenantPrincipal | null>;

const contexts = new WeakMap<object, TenantContext>();

/** The context the guard resolved for `request`, if it has run. */
export function tenantContextOf(request: object): TenantContext | undefined {
  return contexts.get(request);
}

/**
 * The single place the API resolves a tenant (TENANT-003). No principal is `401 unauthenticated`; a
 * principal without exactly one valid tenant is `403 tenant_context_missing`. Either way the handler
 * never runs and no tenant data is touched. The resolved context is handed to
 * {@link TenantContextInterceptor}, which opens the `AsyncLocalStorage` scope around the handler.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_TENANT_PRINCIPAL_SOURCE) private readonly principalSource: TenantPrincipalSource,
    @Inject(API_TENANT_METRICS) private readonly metrics: TenantContextMetrics,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    // HTTP and GraphQL carry a resolvable principal; any other transport is refused, never served.
    const request = requestOf(context);
    if (request === undefined) {
      this.metrics.contextMissing();
      throw new TenantContextMissingError('tenant context is not available on this transport');
    }
    const principal = await this.principalSource(request);
    if (principal === null) throw new AuthError('no authenticated principal');
    const tenant = resolveTenantContext(principal, this.metrics);
    contexts.set(request, tenant);
    bindTenant(tenant.tenantId, { actorType: tenant.actor.type });
    return true;
  }
}
