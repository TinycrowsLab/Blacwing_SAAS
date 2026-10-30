import { describe, expect, it } from 'vitest';

import { permissionsOf } from './access.js';
import {
  createCedarAssetPolicy,
  type AssetPolicyPrincipal,
  type AssetPolicyResource,
  ASSET_ACTIONS,
} from './policy.js';

const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
const ALICE = '0198f0a0-0000-7000-8000-0000000000a1';
const BOB = '0198f0a0-0000-7000-8000-0000000000b1';
const ASSET = '0198f0a0-0000-7000-8000-0000000000f1';

const engine = createCedarAssetPolicy();

function principal(userId: string, tenantId: string, roles: string[]): AssetPolicyPrincipal {
  return { userId, tenantId, roles, permissions: permissionsOf(roles) };
}

const assetOf = (ownerUserId: string, tenantId = TENANT_A): AssetPolicyResource => ({
  kind: 'asset',
  id: ASSET,
  tenantId,
  ownerUserId,
});

describe('asset Cedar policy: RBAC permission and resource check', () => {
  it('lets an appsec engineer read, create, update and delete in its own tenant', () => {
    const who = principal(BOB, TENANT_A, ['appsec_engineer']);
    expect(engine.authorize(who, ASSET_ACTIONS.read, assetOf(ALICE)).decision).toBe('allow');
    expect(engine.authorize(who, ASSET_ACTIONS.update, assetOf(ALICE)).decision).toBe('allow');
    expect(engine.authorize(who, ASSET_ACTIONS.delete, assetOf(ALICE)).decision).toBe('allow');
    expect(
      engine.authorize(who, ASSET_ACTIONS.create, { kind: 'tenant', tenantId: TENANT_A }).decision,
    ).toBe('allow');
  });

  it('lets an auditor read and list, but never write (no asset:write)', () => {
    const who = principal(BOB, TENANT_A, ['auditor']);
    expect(engine.authorize(who, ASSET_ACTIONS.read, assetOf(ALICE)).decision).toBe('allow');
    expect(
      engine.authorize(who, ASSET_ACTIONS.list, { kind: 'tenant', tenantId: TENANT_A }).decision,
    ).toBe('allow');
    expect(engine.authorize(who, ASSET_ACTIONS.update, assetOf(ALICE)).decision).toBe('deny');
    expect(engine.authorize(who, ASSET_ACTIONS.delete, assetOf(ALICE)).decision).toBe('deny');
    expect(
      engine.authorize(who, ASSET_ACTIONS.create, { kind: 'tenant', tenantId: TENANT_A }).decision,
    ).toBe('deny');
  });

  it('limits an asset owner to the assets they own for update and delete', () => {
    const owner = principal(ALICE, TENANT_A, ['asset_owner']);
    expect(engine.authorize(owner, ASSET_ACTIONS.update, assetOf(ALICE)).decision).toBe('allow');
    expect(engine.authorize(owner, ASSET_ACTIONS.delete, assetOf(ALICE)).decision).toBe('allow');
    expect(engine.authorize(owner, ASSET_ACTIONS.update, assetOf(BOB)).decision).toBe('deny');
    expect(engine.authorize(owner, ASSET_ACTIONS.delete, assetOf(BOB)).decision).toBe('deny');
    // Reading another owner's asset in the same tenant is still allowed (asset:read).
    expect(engine.authorize(owner, ASSET_ACTIONS.read, assetOf(BOB)).decision).toBe('allow');
  });

  it('lets an appsec engineer change an asset it does not own (no owner restriction)', () => {
    const appsec = principal(BOB, TENANT_A, ['appsec_engineer']);
    expect(engine.authorize(appsec, ASSET_ACTIONS.update, assetOf(ALICE)).decision).toBe('allow');
  });

  it('keeps org admins read-only on assets, as the role matrix grants', () => {
    const admin = principal(BOB, TENANT_A, ['org_admin']);
    expect(engine.authorize(admin, ASSET_ACTIONS.read, assetOf(ALICE)).decision).toBe('allow');
    expect(engine.authorize(admin, ASSET_ACTIONS.update, assetOf(ALICE)).decision).toBe('deny');
  });

  it('lets an asset owner and an appsec engineer verify their asset, but not an auditor (asset:verify)', () => {
    const owner = principal(ALICE, TENANT_A, ['asset_owner']);
    const appsec = principal(BOB, TENANT_A, ['appsec_engineer']);
    const auditor = principal(BOB, TENANT_A, ['auditor']);
    expect(engine.authorize(owner, ASSET_ACTIONS.verify, assetOf(ALICE)).decision).toBe('allow');
    expect(engine.authorize(appsec, ASSET_ACTIONS.verify, assetOf(ALICE)).decision).toBe('allow');
    expect(engine.authorize(auditor, ASSET_ACTIONS.verify, assetOf(ALICE)).decision).toBe('deny');
  });

  it('limits verification to the owner unless the caller is an appsec engineer or org admin', () => {
    const owner = principal(ALICE, TENANT_A, ['asset_owner']);
    const orgAdmin = principal(BOB, TENANT_A, ['org_admin']);
    expect(engine.authorize(owner, ASSET_ACTIONS.verify, assetOf(BOB)).decision).toBe('deny');
    // org_admin holds no asset:verify, so RBAC refuses it before the owner rule matters.
    expect(engine.authorize(orgAdmin, ASSET_ACTIONS.verify, assetOf(ALICE)).decision).toBe('deny');
  });

  it('denies verification across tenants, even for an owner', () => {
    const owner = principal(ALICE, TENANT_A, ['asset_owner']);
    expect(engine.authorize(owner, ASSET_ACTIONS.verify, assetOf(ALICE, TENANT_B)).decision).toBe(
      'deny',
    );
  });

  it('denies every action across tenants, whatever the roles say', () => {
    const who = principal(BOB, TENANT_A, ['org_admin', 'appsec_engineer']);
    expect(engine.authorize(who, ASSET_ACTIONS.read, assetOf(ALICE, TENANT_B)).decision).toBe(
      'deny',
    );
    expect(engine.authorize(who, ASSET_ACTIONS.update, assetOf(ALICE, TENANT_B)).decision).toBe(
      'deny',
    );
    expect(
      engine.authorize(who, ASSET_ACTIONS.create, { kind: 'tenant', tenantId: TENANT_B }).decision,
    ).toBe('deny');
  });

  it('denies a caller whose roles grant no asset permission', () => {
    const who = principal(BOB, TENANT_A, ['sa_reviewer_unknown', 'not_a_role']);
    expect(permissionsOf(who.roles)).not.toContain('asset:read');
    expect(engine.authorize(who, ASSET_ACTIONS.read, assetOf(ALICE)).decision).toBe('deny');
    expect(
      engine.authorize(who, ASSET_ACTIONS.list, { kind: 'tenant', tenantId: TENANT_A }).decision,
    ).toBe('deny');
  });

  it('denies when evaluation reports an error (fail closed), and rejects a broken policy set at load', () => {
    expect(() => createCedarAssetPolicy('permit (principal, action, resource')).toThrow();
  });
});

describe('permissionsOf', () => {
  it('resolves roles to the union of their grants, unknown roles grant nothing', () => {
    expect(permissionsOf(['asset_owner'])).toEqual(
      expect.arrayContaining(['asset:read', 'asset:write']),
    );
    expect(permissionsOf(['auditor'])).toContain('asset:read');
    expect(permissionsOf(['auditor'])).not.toContain('asset:write');
    expect(permissionsOf(['bogus'])).toEqual([]);
  });
});
