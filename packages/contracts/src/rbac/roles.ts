import { z } from 'zod';

import { type Permission, PLATFORM_PERMISSIONS, type PlatformPermission } from './permissions.js';

/**
 * Tenant roles and the role -> permission matrix (RBAC-001, CONTEXT_PACK §1.2, §7 `memberships.roles[]`).
 *
 * The matrix encodes least privilege and separation of duties (§8.4, F31):
 * - org_admin administers the tenant (SSO, members, policies, connectors, secrets, settings) but does not
 *   operate runs or approve authorisations/gates; approvals belong to asset owners.
 * - appsec_engineer operates runs, edits test plans, manages assets and triages/releases findings (Gate 3).
 * - asset_owner authorises testing of their assets (SA approve/revoke), approves Gate 1 and decides Gate 2.
 * - developer triggers pre-prod runs and retests and consumes findings (environment and "released only"
 *   restrictions are resource checks owned by Cedar, RBAC-004).
 * - auditor is strictly read-only.
 * - ci_pipeline runs unattended inside a standing authorisation: no approval, triage or release.
 *
 * Any change here requires bumping `CATALOGUE_VERSION` and the golden test.
 */

/** Every tenant role, as stored in `memberships.roles[]`. `platform_operator` is deliberately absent. */
export const ROLES = Object.freeze([
  'org_admin',
  'appsec_engineer',
  'asset_owner',
  'developer',
  'auditor',
  'ci_pipeline',
] as const);

/** A tenant role. */
export type Role = (typeof ROLES)[number];

/** Zod schema for a tenant role. Rejects `platform_operator` and anything else outside `ROLES`. */
export const roleSchema = z.enum(ROLES);

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);

/** Type guard: is `value` a tenant role? */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLE_SET.has(value);
}

const freeze = (permissions: readonly Permission[]): readonly Permission[] =>
  Object.freeze([...permissions]);

/** The role -> permission matrix. Frozen; never mutate at runtime. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  org_admin: freeze([
    'asset:read',
    'sa:read',
    'run:read',
    'testplan:read',
    'gate:read',
    'finding:read',
    'report:read',
    'coverage:read',
    'connector:read',
    'connector:write',
    'token:read',
    'token:create',
    'token:revoke',
    'member:read',
    'member:assign',
    'policy:read',
    'policy:write',
    'secret:read',
    'secret:write',
    'settings:read',
    'settings:write',
    'kill:trigger',
    'audit:read',
  ]),
  appsec_engineer: freeze([
    'asset:read',
    'asset:write',
    'asset:verify',
    'sa:read',
    'sa:create',
    'run:read',
    'run:create',
    'run:cancel',
    'testplan:read',
    'testplan:edit',
    'gate:read',
    'finding:read',
    'finding:triage',
    'finding:release',
    'report:read',
    'report:export',
    'coverage:read',
    'connector:read',
    'token:read',
    'token:create',
    'token:revoke',
    'member:read',
    'policy:read',
    'kill:trigger',
  ]),
  asset_owner: freeze([
    'asset:read',
    'asset:write',
    'asset:verify',
    'sa:read',
    'sa:create',
    'sa:approve',
    'sa:revoke',
    'run:read',
    'run:cancel',
    'testplan:read',
    'testplan:approve',
    'gate:read',
    'gate:decide',
    'finding:read',
    'report:read',
    'coverage:read',
    'kill:trigger',
  ]),
  developer: freeze([
    'asset:read',
    'sa:read',
    'run:read',
    'run:create',
    'testplan:read',
    'finding:read',
    'report:read',
    'coverage:read',
  ]),
  auditor: freeze([
    'asset:read',
    'sa:read',
    'run:read',
    'testplan:read',
    'gate:read',
    'finding:read',
    'report:read',
    'coverage:read',
    'policy:read',
    'audit:read',
  ]),
  ci_pipeline: freeze([
    'asset:read',
    'sa:read',
    'run:read',
    'run:create',
    'finding:read',
    'report:read',
  ]),
});

/**
 * The Blackwing Platform Operator (Tinycrows staff). Platform scope, never a tenant role: it is not in
 * `ROLES`, `roleSchema` rejects it, and no tenant role's permissions overlap with its permissions.
 */
export const PLATFORM_OPERATOR = 'platform_operator';
export type PlatformOperator = typeof PLATFORM_OPERATOR;

/** Permissions held by the platform operator (every action is audited, §1.2). */
export const PLATFORM_OPERATOR_PERMISSIONS: readonly PlatformPermission[] = Object.freeze([
  ...PLATFORM_PERMISSIONS,
]);
