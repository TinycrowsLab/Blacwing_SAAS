import { describe, expect, it } from 'vitest';

import { ROLE_PERMISSIONS, ROLES } from './roles.js';
import {
  isServiceAccountRoleAssignable,
  isServiceAccountUsable,
  SERVICE_ACCOUNT_DENIED_PERMISSIONS,
  SERVICE_ACCOUNT_NAME_MAX,
  SERVICE_ACCOUNT_ROLES,
  serviceAccountCreateSchema,
  serviceAccountIdParamSchema,
  serviceAccountListQuerySchema,
  serviceAccountRoleSchema,
  serviceAccountUpdateSchema,
} from './service-accounts.js';

const OWNER = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('service account role policy (RBAC-005, §8.4)', () => {
  it('derives the assignable roles from the matrix: approval and admin roles are excluded', () => {
    expect([...SERVICE_ACCOUNT_ROLES]).toEqual(['developer', 'auditor', 'ci_pipeline']);
    for (const role of ['org_admin', 'appsec_engineer', 'asset_owner'] as const) {
      expect(isServiceAccountRoleAssignable(role), role).toBe(false);
    }
  });

  it('denies every approval and administration permission the policy names', () => {
    expect([...SERVICE_ACCOUNT_DENIED_PERMISSIONS]).toEqual(
      expect.arrayContaining(['sa:approve', 'gate:decide', 'finding:release', 'member:assign']),
    );
    for (const role of ROLES) {
      const denied = ROLE_PERMISSIONS[role].filter((p) =>
        SERVICE_ACCOUNT_DENIED_PERMISSIONS.includes(p),
      );
      expect(isServiceAccountRoleAssignable(role), role).toBe(denied.length === 0);
    }
  });

  it('rejects an approval or admin role at write time, and accepts a least-privilege one', () => {
    expect(serviceAccountRoleSchema.safeParse('ci_pipeline').success).toBe(true);
    expect(serviceAccountRoleSchema.safeParse('org_admin').success).toBe(false);
    expect(serviceAccountRoleSchema.safeParse('asset_owner').success).toBe(false);
    expect(serviceAccountRoleSchema.safeParse('platform_operator').success).toBe(false);
  });
});

describe('serviceAccountCreateSchema', () => {
  const valid = { name: 'ci-scanner', ownerUserId: OWNER, roles: ['ci_pipeline'] };

  it('accepts a minimal valid body and defaults roles to none', () => {
    const parsed = serviceAccountCreateSchema.parse({ name: 'ci', ownerUserId: OWNER });
    expect(parsed.roles).toEqual([]);
  });

  it('trims the name and rejects blank and over-long names', () => {
    expect(serviceAccountCreateSchema.parse({ ...valid, name: '  ci  ' }).name).toBe('ci');
    expect(serviceAccountCreateSchema.safeParse({ ...valid, name: '   ' }).success).toBe(false);
    expect(
      serviceAccountCreateSchema.safeParse({
        ...valid,
        name: 'x'.repeat(SERVICE_ACCOUNT_NAME_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects control characters in the name', () => {
    expect(serviceAccountCreateSchema.safeParse({ ...valid, name: 'ci\u0007bot' }).success).toBe(
      false,
    );
  });

  it('rejects duplicate roles and an approval role', () => {
    expect(
      serviceAccountCreateSchema.safeParse({ ...valid, roles: ['ci_pipeline', 'ci_pipeline'] })
        .success,
    ).toBe(false);
    expect(serviceAccountCreateSchema.safeParse({ ...valid, roles: ['asset_owner'] }).success).toBe(
      false,
    );
  });

  it('rejects a non-UUID owner and unknown keys (no tenant or status from the body)', () => {
    expect(serviceAccountCreateSchema.safeParse({ ...valid, ownerUserId: 'nope' }).success).toBe(
      false,
    );
    expect(serviceAccountCreateSchema.safeParse({ ...valid, tenantId: OWNER }).success).toBe(false);
    expect(serviceAccountCreateSchema.safeParse({ ...valid, status: 'disabled' }).success).toBe(
      false,
    );
  });
});

describe('serviceAccountUpdateSchema', () => {
  it('needs at least one field and never accepts the owner or the tenant', () => {
    expect(serviceAccountUpdateSchema.safeParse({}).success).toBe(false);
    expect(serviceAccountUpdateSchema.safeParse({ ownerUserId: OWNER }).success).toBe(false);
    expect(serviceAccountUpdateSchema.safeParse({ status: 'disabled' }).success).toBe(true);
    expect(serviceAccountUpdateSchema.safeParse({ roles: ['auditor'] }).success).toBe(true);
  });

  it('allows the description to be cleared with null, and rejects an unknown status', () => {
    expect(serviceAccountUpdateSchema.safeParse({ description: null }).success).toBe(true);
    expect(serviceAccountUpdateSchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });
});

describe('query and path schemas', () => {
  it('bounds the page size and rejects unknown query keys', () => {
    expect(serviceAccountListQuerySchema.parse({}).limit).toBe(50);
    expect(serviceAccountListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(serviceAccountListQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(serviceAccountListQuerySchema.safeParse({ tenant: 'x' }).success).toBe(false);
  });

  it('requires a UUID id in the path', () => {
    expect(serviceAccountIdParamSchema.safeParse({ id: OWNER }).success).toBe(true);
    expect(serviceAccountIdParamSchema.safeParse({ id: '../x' }).success).toBe(false);
  });
});

describe('isServiceAccountUsable', () => {
  it('fails closed for a disabled account', () => {
    expect(isServiceAccountUsable({ status: 'active' })).toBe(true);
    expect(isServiceAccountUsable({ status: 'disabled' })).toBe(false);
  });
});
