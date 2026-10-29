import { describe, expect, it } from 'vitest';

import {
  ADMIN_A,
  ADMIN_B,
  APPSEC2_A,
  APPSEC_A,
  AUDITOR_A,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';
import { createCedarSaPolicy, SA_POLICY_SET, SaPolicyLoadError } from './policy.js';

const admin = { userId: ADMIN_A, tenantId: TENANT_A, roles: ['org_admin'] };
const appsec = { userId: APPSEC_A, tenantId: TENANT_A, roles: ['appsec_engineer'] };
const appsecOther = { userId: APPSEC2_A, tenantId: TENANT_A, roles: ['appsec_engineer'] };
const owner = { userId: APPSEC2_A, tenantId: TENANT_A, roles: ['asset_owner'] };
const auditor = { userId: AUDITOR_A, tenantId: TENANT_A, roles: ['auditor'] };
const adminB = { userId: ADMIN_B, tenantId: TENANT_B, roles: ['org_admin'] };
const tenantA = { kind: 'Tenant', tenantId: TENANT_A } as const;
const sa = (requesterId: string, tenantId = TENANT_A) =>
  ({
    kind: 'StandingAuthorisation',
    id: '0198f0a0-0000-7000-8000-0000000000c1',
    tenantId,
    requesterId,
  }) as const;

describe('standing-authorisation Cedar policy', () => {
  const policy = createCedarSaPolicy();

  it('lets an appsec engineer or asset owner (sa:create holders) create a draft in their own tenant only', () => {
    expect(policy.allows(appsec, 'create', tenantA)).toBe(true);
    expect(policy.allows(owner, 'create', tenantA)).toBe(true);
    expect(policy.allows(admin, 'create', tenantA)).toBe(false);
    expect(policy.allows(auditor, 'create', tenantA)).toBe(false);
    expect(policy.allows(adminB, 'create', tenantA)).toBe(false);
  });

  it('lets any principal of the tenant read, and never another tenant', () => {
    expect(policy.allows(auditor, 'read', sa(ADMIN_A))).toBe(true);
    expect(policy.allows(adminB, 'read', sa(ADMIN_A))).toBe(false);
    expect(policy.allows(adminB, 'read', tenantA)).toBe(false);
  });

  it('lets only the requester update or submit a draft (separation of duties)', () => {
    expect(policy.allows(appsec, 'update', sa(APPSEC_A))).toBe(true);
    expect(policy.allows(appsec, 'submit', sa(APPSEC_A))).toBe(true);
    expect(policy.allows(appsecOther, 'update', sa(APPSEC_A))).toBe(false);
    expect(policy.allows(appsecOther, 'submit', sa(APPSEC_A))).toBe(false);
  });

  it('denies a cross-tenant change even for the requester id, the tenant isolation forbid', () => {
    expect(policy.allows(adminB, 'update', sa(ADMIN_B, TENANT_A))).toBe(false);
  });

  it('refuses to load a broken policy set (fail closed)', () => {
    expect(() => createCedarSaPolicy('permit (principal, action, resource')).toThrow(
      SaPolicyLoadError,
    );
  });

  it('keeps every policy under a unique @id', () => {
    expect(SA_POLICY_SET.match(/@id\("[^"]+"\)/g)).toHaveLength(5);
  });
  it('lets only an asset owner of the tenant approve or reject, the requester included (SoD is checked in the domain)', () => {
    expect(policy.allows(owner, 'approve', sa(ADMIN_A))).toBe(true);
    expect(policy.allows(owner, 'reject', sa(ADMIN_A))).toBe(true);
    expect(policy.allows(appsec, 'approve', sa(ADMIN_A))).toBe(false);
    expect(policy.allows(auditor, 'reject', sa(ADMIN_A))).toBe(false);
    expect(policy.allows(owner, 'approve', sa(ADMIN_A, TENANT_B))).toBe(false);
    expect(policy.allows(adminB, 'approve', sa(ADMIN_A))).toBe(false);
  });
});
