import {
  CATALOGUE_VERSION,
  isRole,
  type Permission,
  ROLE_PERMISSIONS,
  type Role,
} from '@blackwing/contracts';

/**
 * RBAC helpers over the permission catalogue (RBAC-001). Pure: no IO, no globals, deny by default.
 *
 * Roles come from `memberships.roles[]`, which is untrusted storage, so the helpers accept arbitrary strings.
 * Unknown roles (typos, removed roles, `platform_operator`) grant nothing and are reported to the optional
 * warning sink, which callers wire to `@blackwing/logger` (its `warn(obj, msg)` signature matches).
 */

/** Minimal structured-warning sink, compatible with a pino / `@blackwing/logger` logger. */
export interface RbacWarnSink {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/** Options for the RBAC helpers. */
export interface RbacOptions {
  /** Receives one warning per unknown role encountered. Omit to ignore silently (still denies). */
  readonly logger?: RbacWarnSink;
}

/** Stable message logged for an unknown role. */
export const UNKNOWN_ROLE_WARNING = 'rbac: ignoring unknown role';

/** Unknown role values are untrusted storage content; only this many characters reach a log line. */
const MAX_LOGGED_ROLE_LENGTH = 64;

/**
 * The union of the permissions granted by `roles`. Unknown roles are ignored (and warned about); an empty
 * or entirely unknown list yields an empty set, which denies everything.
 */
export function permissionsForRoles(
  roles: readonly string[],
  options: RbacOptions = {},
): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    if (!isRole(role)) {
      // Never echo the raw value into logs unbounded; it is untrusted storage content.
      options.logger?.warn(
        { role: role.slice(0, MAX_LOGGED_ROLE_LENGTH), catalogueVersion: CATALOGUE_VERSION },
        UNKNOWN_ROLE_WARNING,
      );
      continue;
    }
    for (const permission of ROLE_PERMISSIONS[role]) {
      granted.add(permission);
    }
  }
  return granted;
}

/** True when at least one of `roles` grants `permission`. Deny by default. */
export function hasPermission(
  roles: readonly string[],
  permission: Permission,
  options: RbacOptions = {},
): boolean {
  return permissionsForRoles(roles, options).has(permission);
}

/** The known tenant roles in `roles`, deduplicated, in input order. Unknown values are dropped. */
export function knownRoles(roles: readonly string[]): readonly Role[] {
  return [...new Set(roles.filter(isRole))];
}
