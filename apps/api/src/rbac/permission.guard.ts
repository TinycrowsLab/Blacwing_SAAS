import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { effectivePermissions, type PermissionRequirement, satisfies } from '@blackwing/domain';
import { AuthError, ForbiddenError } from '@blackwing/errors';

import { AUTHENTICATED_ONLY_KEY, RBAC_REQUIREMENT_KEY } from './require-permission.decorator.js';
import { UNMATCHED_ROUTE } from '../bootstrap/metrics.js';
import { API_LOGGER, API_RBAC_METRICS } from '../bootstrap/tokens.js';
import { requestOf } from '../bootstrap/transport.js';
import { authorizedPrincipalOf, type AuthorizedPrincipal } from '../tenant/guard.js';
import { PUBLIC_ROUTE_KEY } from '../tenant/public-route.js';

import type { RbacMetrics } from './metrics.js';
import type { Logger } from '@blackwing/logger';
import type { FastifyRequest } from 'fastify';

/** Metric and log label for a route that declares no policy. */
const UNDECLARED = 'undeclared';

/**
 * The RBAC permission guard (RBAC-003), shared by REST and GraphQL. It runs right after the tenant guard, on
 * the principal that guard validated. Deny by default:
 * - `@PublicRoute()` (probes, banner) passes, as it does for the tenant guard;
 * - no principal is `401 unauthenticated` before any permission is evaluated;
 * - a route with `@RequirePermission` / `@RequireAnyPermission` needs the caller's effective permissions to
 *   satisfy it (see `effectivePermissions`: a token holds only what its scopes name, intersected with its
 *   roles);
 * - a route with `@AuthenticatedOnly()` passes for any authenticated caller;
 * - a route with none of these passes for a session (`user`), whose access stays with the per-service policies
 *   (assets, findings, ...), and is refused `403 permission_denied` for a token (`service` / `run`), so a new
 *   token-reachable endpoint fails closed until it declares its policy.
 * A refusal logs `rbac.denied` at warn and increments `bw_rbac_denials_total{permission}`.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_LOGGER) private readonly logger: Logger,
    @Inject(API_RBAC_METRICS) private readonly metrics: RbacMetrics,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handlers = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE_KEY, handlers) === true
    ) {
      return true;
    }
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      RBAC_REQUIREMENT_KEY,
      handlers,
    );
    const authenticatedOnly =
      this.reflector.getAllAndOverride<boolean | undefined>(AUTHENTICATED_ONLY_KEY, handlers) ===
      true;

    const request = requestOf(context);
    const principal = request === undefined ? undefined : authorizedPrincipalOf(request);
    if (request === undefined || principal === undefined) {
      throw new AuthError('no authenticated principal');
    }

    if (requirement === undefined) {
      if (authenticatedOnly || principal.actor.type === 'user') return true;
      return this.refuse(principal, context, request, UNDECLARED);
    }

    const granted = effectivePermissions({
      actorType: principal.actor.type,
      roles: principal.roles ?? [],
      scopes: principal.scopes,
    });
    if (satisfies(granted, requirement)) return true;
    return this.refuse(principal, context, request, requirement.permissions.join(','));
  }

  private refuse(
    principal: AuthorizedPrincipal,
    context: ExecutionContext,
    request: FastifyRequest,
    permission: string,
  ): never {
    this.metrics.denied(permission);
    this.logger.warn(
      { principal: principal.actor.id, permission, route: routeOf(context, request) },
      'rbac.denied',
    );
    // FORBIDDEN is the registry's `permission_denied` problem code (RFC 9457 type), shared with every RBAC refusal.
    throw new ForbiddenError('you are not permitted to perform this action');
  }
}

/**
 * The route template for REST (never the raw URL: no ids or query strings in logs) or the GraphQL field
 * (`Class.handler`), which is bounded by the schema.
 */
function routeOf(context: ExecutionContext, request: FastifyRequest): string {
  if (context.getType() === 'http') return request.routeOptions.url ?? UNMATCHED_ROUTE;
  return `${context.getClass().name}.${context.getHandler().name}`;
}
