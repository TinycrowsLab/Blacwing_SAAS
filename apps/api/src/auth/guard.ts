import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthNoCredentialsError } from './errors.js';
import { PUBLIC_ROUTE_KEY } from '../tenant/public-route.js';

import type { Authenticator } from './authenticate.js';
import type { Principal } from '@blackwing/contracts';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { FastifyRequest } from 'fastify';

/** DI token of the {@link Authenticator} the guard runs. */
export const API_AUTHENTICATOR = Symbol.for('blackwing.api.authenticator');

const principals = new WeakMap<object, Principal>();

/** The principal the auth guard attached to `request`, or `undefined` for a public route or no run. */
function principalOf(request: object): Principal | undefined {
  return principals.get(request);
}

/**
 * The step-up evidence of the validated principal: its `acr` and `auth_time`, when the IdP reported them (AUTHZ-008).
 * `undefined` when the request carries no validated principal.
 */
export function authEvidenceOf(
  request: object,
): { readonly acr?: string; readonly authTime?: number } | undefined {
  const principal = principalOf(request);
  if (principal === undefined) return undefined;
  return {
    ...(principal.acr === undefined ? {} : { acr: principal.acr }),
    ...(principal.authTime === undefined ? {} : { authTime: principal.authTime }),
  };
}

/**
 * The one global authentication guard (#335, APP_GUARD). Every route not marked `@PublicRoute()` must present
 * a valid credential; its principal is attached to the request for tenant context (TENANT-003) and RBAC.
 * It runs before the tenant guard, so an unauthenticated request never reaches tenant resolution.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_AUTHENTICATOR) private readonly authenticator: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    // Only HTTP carries credentials today; any other transport is refused, never served.
    if (context.getType() !== 'http') throw new AuthNoCredentialsError();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    principals.set(request, await this.authenticator.authenticate(request.headers));
    return true;
  }
}

/**
 * Adapts the attached principal to the tenant guard's source (TENANT-003). Both the session and the Keycloak
 * token carry their tenant in the session-scoped claim, so the tenant is taken from the validated principal only.
 */
export function tenantPrincipalFromRequest(request: FastifyRequest): TenantPrincipal | null {
  const principal = principalOf(request);
  if (principal === undefined) return null;
  return {
    actor: { type: principal.kind, id: principal.subjectId },
    sessionTenantId: principal.tenantId,
  };
}
