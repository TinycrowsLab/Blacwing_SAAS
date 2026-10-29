import { z } from 'zod';

/**
 * Permission catalogue (RBAC-001, CONTEXT_PACK §1.2, §9 "Authz: RBAC permission check + Cedar resource check").
 *
 * The single source of truth for every `<resource>:<action>` permission a tenant role can hold. Guards
 * (RBAC-003), Cedar resource checks (RBAC-004) and introspection endpoints read this list; nothing else may
 * invent a permission string. Pure data, no IO, so api/web/cli share it.
 *
 * Changing the catalogue or the role matrix (`roles.ts`) requires bumping `CATALOGUE_VERSION` and updating the
 * pinned golden matrix and digest in `rbac.test.ts`, which makes every grant change reviewable.
 */

/** Version of the permission catalogue and role matrix. Bump on any change to either. */
export const CATALOGUE_VERSION = 3;

/** Format every permission string must match: `<resource>:<action>`, lowercase snake_case segments. */
export const PERMISSION_PATTERN = /^[a-z_]+:[a-z_]+$/;

/** Every tenant permission, grouped by resource. */
export const PERMISSIONS = Object.freeze([
  // assets and ownership verification (F1-F6)
  'asset:read',
  'asset:write',
  'asset:verify',
  // standing authorisations
  'sa:read',
  'sa:create',
  'sa:approve',
  'sa:revoke',
  // assessment requests (SCOPE-005): drafting and submitting the scoping form
  'assessment:create',
  // runs
  'run:read',
  'assessment:read',
  'run:create',
  'run:cancel',
  // test plans (Gate 1)
  'testplan:read',
  'testplan:edit',
  'testplan:approve',
  // runtime exceptions (Gate 2)
  'gate:read',
  'gate:decide',
  // findings (Gate 3)
  'finding:read',
  'finding:triage',
  'finding:release',
  // reports and coverage
  'report:read',
  'report:export',
  'coverage:read',
  // tracker / notification connectors
  'connector:read',
  'connector:write',
  // personal and CI tokens
  'token:read',
  'token:create',
  'token:revoke',
  // memberships and roles
  'member:read',
  'member:assign',
  // tenant policies
  'policy:read',
  'policy:write',
  // secret references (never plaintext values)
  'secret:read',
  'secret:write',
  // tenant settings: SSO, retention, model endpoint
  'settings:read',
  'settings:write',
  // tenant-scoped kill switch (run/asset/tenant)
  'kill:trigger',
  // audit ledger
  'audit:read',
] as const);

/** A tenant permission: a closed union of `<resource>:<action>` strings. */
export type Permission = (typeof PERMISSIONS)[number];

/** Zod schema for a tenant permission; rejects anything outside the catalogue. */
export const permissionSchema = z.enum(PERMISSIONS);

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

/** Type guard: is `value` a catalogued tenant permission? */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** True when `permission` is read-only (`<resource>:read`). */
export function isReadPermission(permission: Permission): boolean {
  return permission.endsWith(':read');
}

/**
 * Platform-operator permissions (Tinycrows staff, CONTEXT_PACK §1.2). These live outside the tenant
 * catalogue: no tenant role grants them and the membership API (RBAC-002) cannot assign them.
 */
export const PLATFORM_PERMISSIONS = Object.freeze([
  'platform:tenant_support',
  'platform:verification_review',
  'platform:global_kill',
  'platform:release_manage',
] as const);

/** A platform-scope permission. Disjoint from `Permission` by construction (`platform:` resource). */
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/** Zod schema for a platform-scope permission. */
export const platformPermissionSchema = z.enum(PLATFORM_PERMISSIONS);
