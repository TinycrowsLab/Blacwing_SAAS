import { SetMetadata } from '@nestjs/common';

import { isPermission, type Permission } from '@blackwing/contracts';

import type { PermissionRequirement } from '@blackwing/domain';

/** Metadata key of {@link RequirePermission} and {@link RequireAnyPermission}. */
export const RBAC_REQUIREMENT_KEY = Symbol.for('blackwing.api.rbac.requirement');

/** Metadata key of {@link AuthenticatedOnly}. */
export const AUTHENTICATED_ONLY_KEY = Symbol.for('blackwing.api.rbac.authenticated-only');

/**
 * Rejects anything outside the closed catalogue at boot, for callers that bypass the type system. The
 * decorator runs when the module loads, so a typo never reaches a request.
 */
function requirement(
  mode: PermissionRequirement['mode'],
  permissions: readonly string[],
): PermissionRequirement {
  for (const permission of permissions) {
    if (!isPermission(permission)) {
      throw new TypeError(`RBAC decorator names a permission outside the catalogue: ${permission}`);
    }
  }
  return { mode, permissions: permissions as readonly Permission[] };
}

/**
 * The route needs **every** listed permission (RBAC-003). The check reads the principal's roles and the
 * token scopes through the RBAC core; the names are a closed union, so an unknown permission does not
 * type-check. Put it on a handler or on a controller.
 */
export const RequirePermission = (
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator =>
  SetMetadata(RBAC_REQUIREMENT_KEY, requirement('all', permissions));

/** The route needs **at least one** of the listed permissions (RBAC-003). */
export const RequireAnyPermission = (
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator =>
  SetMetadata(RBAC_REQUIREMENT_KEY, requirement('any', permissions));

/**
 * The route needs an authenticated principal and no specific permission. Use it for endpoints every
 * signed-in member may reach (for example "who am I"). Undecorated routes are denied (fail closed).
 */
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_ONLY_KEY, true);
