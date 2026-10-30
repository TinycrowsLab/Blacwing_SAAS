import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../audit/jcs.js';
import * as contracts from '../index.js';
import {
  CATALOGUE_VERSION,
  isPermission,
  isReadPermission,
  type Permission,
  PERMISSION_PATTERN,
  permissionSchema,
  PERMISSIONS,
  PLATFORM_PERMISSIONS,
  platformPermissionSchema,
} from './permissions.js';
import {
  isRole,
  PLATFORM_OPERATOR,
  PLATFORM_OPERATOR_PERMISSIONS,
  type Role,
  ROLE_PERMISSIONS,
  roleSchema,
  ROLES,
} from './roles.js';

/**
 * Golden pin of the role -> permission matrix. Adding or removing any grant fails this test until the golden
 * file, the digest below and CATALOGUE_VERSION are updated together, so every change is visible in review.
 */
const golden = JSON.parse(
  readFileSync(new URL('./role-matrix.golden.json', import.meta.url), 'utf8'),
) as {
  catalogueVersion: number;
  permissions: string[];
  platformPermissions: string[];
  roles: Record<string, string[]>;
};

/** sha256(JCS({permissions, roles})) per released catalogue version. Append-only. */
const RELEASED_DIGESTS: Readonly<Record<number, string>> = {
  1: '94b2f8ca5dd8b0594b6ab5c1c0823c5c42cb4ca18b164a484db1633f4ebdd298',
  2: '9438d61a035a0aec87515d3a63b592292fcb63870fbf2047049bc5f798f6c3b8',
  3: '444cbb7493fa2a7c16b8e002b4bf790598db23a857e2db97c175ce8e89db40af',
  4: '68fe7ab8eee29ee74a17b22b08555973f68b53f4db27c1ff89ba236d31a91298',
};

const digest = (): string =>
  createHash('sha256')
    .update(canonicalJson({ permissions: [...PERMISSIONS], roles: ROLE_PERMISSIONS }))
    .digest('hex');

describe('RBAC catalogue (RBAC-001)', () => {
  it('pins the full role -> permission matrix against the golden file', () => {
    expect(golden.catalogueVersion).toBe(CATALOGUE_VERSION);
    expect([...PERMISSIONS]).toEqual(golden.permissions);
    expect([...PLATFORM_PERMISSIONS]).toEqual(golden.platformPermissions);
    expect(Object.keys(ROLE_PERMISSIONS)).toEqual([...ROLES]);
    for (const role of ROLES) {
      expect([...ROLE_PERMISSIONS[role]], role).toEqual(golden.roles[role]);
    }
    expect(Object.keys(golden.roles)).toEqual([...ROLES]);
  });

  it('ties the matrix digest to CATALOGUE_VERSION so a grant change forces a version bump', () => {
    expect(RELEASED_DIGESTS[CATALOGUE_VERSION]).toBe(digest());
  });

  it('every permission matches <resource>:<action> and is unique (catches typos and duplicates)', () => {
    for (const permission of [...PERMISSIONS, ...PLATFORM_PERMISSIONS]) {
      expect(permission).toMatch(PERMISSION_PATTERN);
      expect(permission).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    expect(new Set(PLATFORM_PERMISSIONS).size).toBe(PLATFORM_PERMISSIONS.length);
  });

  it('format pattern rejects malformed strings', () => {
    for (const bad of [
      'asset',
      'Asset:read',
      'asset:read:x',
      'asset-x:read',
      ':read',
      'asset:',
      ' asset:read',
    ]) {
      expect(PERMISSION_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('covers the v1 resources listed by the issue', () => {
    const required: Permission[] = [
      'asset:read',
      'asset:write',
      'asset:verify',
      'sa:read',
      'sa:create',
      'sa:approve',
      'sa:revoke',
      'run:read',
      'run:create',
      'run:cancel',
      'testplan:read',
      'testplan:edit',
      'testplan:approve',
      'finding:read',
      'finding:triage',
      'finding:release',
      'report:read',
      'report:export',
      'connector:read',
      'connector:write',
      'token:read',
      'token:create',
      'token:revoke',
      'member:read',
      'member:assign',
      'policy:read',
      'policy:write',
      'audit:read',
    ];
    for (const permission of required) expect(PERMISSIONS).toContain(permission);
  });

  it('every role grants only catalogued permissions, without duplicates', () => {
    for (const role of ROLES) {
      const grants = ROLE_PERMISSIONS[role];
      expect(new Set(grants).size, role).toBe(grants.length);
      for (const permission of grants)
        expect(isPermission(permission), `${role} ${permission}`).toBe(true);
    }
  });

  it('every catalogued permission is granted to at least one role (no dead entries)', () => {
    const granted = new Set(ROLES.flatMap((role) => ROLE_PERMISSIONS[role]));
    for (const permission of PERMISSIONS) expect(granted.has(permission), permission).toBe(true);
  });

  it('auditor is strictly read-only', () => {
    for (const permission of ROLE_PERMISSIONS.auditor) {
      expect(isReadPermission(permission), permission).toBe(true);
    }
    expect(ROLE_PERMISSIONS.auditor).toContain('audit:read');
  });

  it('ci_pipeline lacks every approval, triage, release and decision permission (SoD)', () => {
    const forbidden = /:(approve|triage|release|decide|assign|revoke|write|edit)$/;
    for (const permission of ROLE_PERMISSIONS.ci_pipeline)
      expect(permission).not.toMatch(forbidden);
    for (const permission of [
      'sa:approve',
      'testplan:approve',
      'gate:decide',
      'finding:triage',
      'finding:release',
    ] as const) {
      expect(ROLE_PERMISSIONS.ci_pipeline).not.toContain(permission);
    }
  });

  it('approvals (SA, Gate 1, Gate 2) belong only to asset_owner; release only to appsec_engineer', () => {
    const holders = (permission: Permission): Role[] =>
      ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));
    expect(holders('sa:approve')).toEqual(['asset_owner']);
    expect(holders('testplan:approve')).toEqual(['asset_owner']);
    expect(holders('gate:decide')).toEqual(['asset_owner']);
    expect(holders('finding:release')).toEqual(['appsec_engineer']);
    expect(holders('finding:triage')).toEqual(['appsec_engineer']);
    expect(holders('member:assign')).toEqual(['org_admin']);
  });

  it('developer can create runs and consume findings but not triage, release or approve', () => {
    const dev = ROLE_PERMISSIONS.developer;
    expect(dev).toContain('run:create');
    expect(dev).toContain('finding:read');
    for (const permission of dev)
      expect(permission).not.toMatch(/:(approve|triage|release|decide|assign)$/);
  });

  it('platform_operator is modelled outside the tenant role enum and catalogue', () => {
    expect(PLATFORM_OPERATOR).toBe('platform_operator');
    expect(ROLES as readonly string[]).not.toContain(PLATFORM_OPERATOR);
    expect(roleSchema.safeParse(PLATFORM_OPERATOR).success).toBe(false);
    expect(isRole(PLATFORM_OPERATOR)).toBe(false);
    expect(Object.keys(ROLE_PERMISSIONS)).not.toContain(PLATFORM_OPERATOR);
    for (const permission of PLATFORM_OPERATOR_PERMISSIONS) {
      expect(permission.startsWith('platform:')).toBe(true);
      expect(isPermission(permission)).toBe(false);
      expect(permissionSchema.safeParse(permission).success).toBe(false);
      expect(platformPermissionSchema.safeParse(permission).success).toBe(true);
    }
    for (const permission of PERMISSIONS) expect(permission.startsWith('platform:')).toBe(false);
  });

  it('schemas accept catalogued values and reject everything else', () => {
    for (const role of ROLES) expect(roleSchema.parse(role)).toBe(role);
    for (const permission of PERMISSIONS)
      expect(permissionSchema.parse(permission)).toBe(permission);
    for (const bad of ['', 'admin', 'ORG_ADMIN', 'org_admin ', 42, null]) {
      expect(roleSchema.safeParse(bad).success).toBe(false);
      expect(isRole(bad)).toBe(false);
    }
    for (const bad of ['asset:delete', 'asset:*', '*:*', 'asset:read ', 7]) {
      expect(permissionSchema.safeParse(bad).success).toBe(false);
      expect(isPermission(bad)).toBe(false);
    }
  });

  it('the catalogue and matrix are frozen', () => {
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    for (const role of ROLES) expect(Object.isFrozen(ROLE_PERMISSIONS[role])).toBe(true);
    expect(() => {
      (ROLE_PERMISSIONS.auditor as Permission[]).push('member:assign');
    }).toThrow(TypeError);
  });

  it('is re-exported from the package root', () => {
    expect(contracts.CATALOGUE_VERSION).toBe(CATALOGUE_VERSION);
    expect(contracts.ROLE_PERMISSIONS).toBe(ROLE_PERMISSIONS);
    expect(contracts.PERMISSIONS).toBe(PERMISSIONS);
    expect(contracts.roleSchema).toBe(roleSchema);
  });
});
