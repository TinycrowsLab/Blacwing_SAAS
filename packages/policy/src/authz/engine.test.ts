import { describe, expect, it } from 'vitest';

import {
  AuthzPolicyLoadError,
  can,
  createAuthzEngine,
  loadAuthzSources,
  type AuthzSources,
} from './engine.js';
import { AUTHZ_ACTIONS, type AuthzPrincipal, type AuthzResource } from './entities.js';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';

const owner = (over: Partial<AuthzPrincipal & { kind: 'user' }> = {}): AuthzPrincipal => ({
  kind: 'user',
  tenantId: TENANT,
  userId: 'user-owner',
  roles: ['asset_owner'],
  ...over,
});

const user = (roles: readonly string[], userId = 'user-other'): AuthzPrincipal => ({
  kind: 'user',
  tenantId: TENANT,
  userId,
  roles,
});

const assetOwnedBy = (
  ownerUserId: string,
  assetId = 'asset-1',
  tenantId = TENANT,
): AuthzResource => ({
  kind: 'asset',
  tenantId,
  assetId,
  ownerUserId,
});

const sa = (
  over: { scopes?: readonly string[]; assetIds?: readonly string[]; tenantId?: string } = {},
): AuthzPrincipal => ({
  kind: 'service_account',
  tenantId: over.tenantId ?? TENANT,
  saId: 'sa-1',
  scopes: over.scopes ?? ['asset:read'],
  assetIds: over.assetIds ?? ['asset-1'],
});

const saRequest = (
  requesterId: string,
  assetOwnerIds: readonly string[],
  tenantId = TENANT,
): AuthzResource => ({
  kind: 'standing_authorisation',
  tenantId,
  saId: 'sa-request-1',
  requesterId,
  assetOwnerIds,
});

describe('authz baseline (#345): ownership and asset scope', () => {
  it('lets an asset owner read and write an asset they own', () => {
    expect(can(owner(), 'asset:read', assetOwnedBy('user-owner')).allow).toBe(true);
    expect(can(owner(), 'asset:write', assetOwnedBy('user-owner')).allow).toBe(true);
  });

  it('denies an asset owner acting on an asset they do not own', () => {
    const decision = can(owner(), 'asset:write', assetOwnedBy('someone-else'));
    expect(decision.allow).toBe(false);
    expect(decision.errors).toEqual([]);
  });

  it('denies a developer who merely shares a role with owners on an asset they do not own', () => {
    expect(can(user(['developer']), 'asset:read', assetOwnedBy('user-owner')).allow).toBe(false);
  });

  it('lets appsec_engineer and org_admin act on any asset in their tenant', () => {
    expect(can(user(['appsec_engineer']), 'asset:write', assetOwnedBy('user-owner')).allow).toBe(
      true,
    );
    expect(can(user(['org_admin']), 'asset:read', assetOwnedBy('user-owner')).allow).toBe(true);
  });

  it('denies a user with no roles and no ownership', () => {
    expect(can(user([]), 'asset:read', assetOwnedBy('user-owner')).allow).toBe(false);
  });
});

describe('authz baseline (#345): tenant match is always required (§8.6)', () => {
  it('denies an owner whose tenant differs from the resource tenant, even with a matching owner id', () => {
    const principal = owner({ tenantId: OTHER_TENANT });
    const decision = can(principal, 'asset:read', assetOwnedBy('user-owner'));
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toContain('authz.tenant_isolation');
  });

  it("denies a tenant-wide staff role on another tenant's asset", () => {
    const decision = can(
      user(['org_admin']),
      'asset:write',
      assetOwnedBy('user-owner', 'asset-1', OTHER_TENANT),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toContain('authz.tenant_isolation');
  });

  it('denies a cross-tenant run and finding read', () => {
    expect(
      can(owner({ tenantId: OTHER_TENANT }), 'run:read', {
        kind: 'run',
        tenantId: TENANT,
        runId: 'run-1',
        ownerUserId: 'user-owner',
      }).allow,
    ).toBe(false);
    expect(
      can(user(['appsec_engineer']), 'finding:read', {
        kind: 'finding',
        tenantId: OTHER_TENANT,
        findingId: 'fnd-1',
        ownerUserId: 'user-owner',
      }).allow,
    ).toBe(false);
  });

  it('denies a service account whose tenant differs from the asset', () => {
    expect(
      can(sa({ tenantId: OTHER_TENANT }), 'asset:read', assetOwnedBy('user-owner')).allow,
    ).toBe(false);
  });
});

describe('authz baseline (#345): service account principals', () => {
  it('allows a service account with the scope on an asset inside its asset scope', () => {
    expect(can(sa(), 'asset:read', assetOwnedBy('user-owner', 'asset-1')).allow).toBe(true);
  });

  it('denies a service account on an asset outside its asset scope (IDOR)', () => {
    expect(can(sa(), 'asset:read', assetOwnedBy('user-owner', 'asset-2')).allow).toBe(false);
  });

  it('denies a service account that lacks the scope', () => {
    expect(can(sa({ scopes: [] }), 'asset:read', assetOwnedBy('user-owner', 'asset-1')).allow).toBe(
      false,
    );
  });

  it('denies a service account write, approval and run read (no policy grants them)', () => {
    expect(
      can(sa({ scopes: ['asset:write'] }), 'asset:write', assetOwnedBy('user-owner')).allow,
    ).toBe(false);
    expect(can(sa(), 'sa:approve', saRequest('user-requester', ['user-owner'])).allow).toBe(false);
    expect(
      can(sa(), 'run:read', {
        kind: 'run',
        tenantId: TENANT,
        runId: 'run-1',
        ownerUserId: 'user-owner',
      }).allow,
    ).toBe(false);
  });
});

describe('authz baseline (#345): standing authorisation approval and separation of duties', () => {
  it('lets an asset_owner approve a standing authorisation whose assets they all own', () => {
    expect(can(owner(), 'sa:approve', saRequest('user-requester', ['user-owner'])).allow).toBe(
      true,
    );
  });

  it('denies an asset_owner approving an SA that covers an asset owned by someone else', () => {
    expect(
      can(owner(), 'sa:approve', saRequest('user-requester', ['user-owner', 'user-other'])).allow,
    ).toBe(false);
  });

  it('denies approval when the SA resolves no owners (fail closed)', () => {
    expect(can(owner(), 'sa:approve', saRequest('user-requester', [])).allow).toBe(false);
  });

  it('denies an approver who is not an asset_owner role, even when they own the assets', () => {
    expect(
      can(
        owner({ roles: ['developer'] }),
        'sa:approve',
        saRequest('user-requester', ['user-owner']),
      ).allow,
    ).toBe(false);
  });

  it('denies requester self-approval even when the requester owns every asset (SoD forbid wins)', () => {
    const decision = can(owner(), 'sa:approve', saRequest('user-owner', ['user-owner']));
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toContain('authz.sa_approve_separation_of_duties');
  });
});

describe('authz baseline (#345): run and finding reads', () => {
  it('lets the run owner and staff read a run, and denies an unrelated developer', () => {
    const run = {
      kind: 'run' as const,
      tenantId: TENANT,
      runId: 'run-1',
      ownerUserId: 'user-owner',
    };
    expect(can(owner(), 'run:read', run).allow).toBe(true);
    expect(can(user(['appsec_engineer']), 'run:read', run).allow).toBe(true);
    expect(can(user(['developer']), 'run:read', run).allow).toBe(false);
  });

  it('lets the finding owner and staff read a finding, and denies an unrelated developer', () => {
    const finding = {
      kind: 'finding' as const,
      tenantId: TENANT,
      findingId: 'fnd-1',
      ownerUserId: 'user-owner',
    };
    expect(can(owner(), 'finding:read', finding).allow).toBe(true);
    expect(can(user(['org_admin']), 'finding:read', finding).allow).toBe(true);
    expect(can(user(['developer']), 'finding:read', finding).allow).toBe(false);
  });
});

describe('authz baseline (#345): fail closed', () => {
  it('denies when a required resource attribute is missing (never assume)', () => {
    const broken = {
      kind: 'asset',
      tenantId: TENANT,
      assetId: 'asset-1',
    } as unknown as AuthzResource;
    const decision = can(owner(), 'asset:read', broken);
    expect(decision.allow).toBe(false);
  });

  it('denies an action the schema does not define', () => {
    const decision = can(
      owner(),
      'asset:delete' as unknown as 'asset:read',
      assetOwnedBy('user-owner'),
    );
    expect(decision.allow).toBe(false);
  });

  it('denies an action applied to a principal type it does not accept', () => {
    expect(can(sa(), 'asset:write', assetOwnedBy('user-owner')).allow).toBe(false);
  });

  it('is deterministic for the same inputs', () => {
    const first = can(owner(), 'asset:read', assetOwnedBy('user-owner'));
    const second = can(owner(), 'asset:read', assetOwnedBy('user-owner'));
    expect(second).toEqual(first);
  });

  it('exposes the complete action list used by the schema', () => {
    expect([...AUTHZ_ACTIONS].sort()).toEqual(
      ['asset:read', 'asset:write', 'finding:read', 'run:read', 'sa:approve'].sort(),
    );
  });
});

describe('createAuthzEngine (#345): the baseline is validated before it can answer', () => {
  const sources = loadAuthzSources();

  it('loads the shipped schema and baseline', () => {
    expect(() => createAuthzEngine(sources)).not.toThrow();
  });

  it('refuses to start on a policy that does not parse', () => {
    const bad: AuthzSources = { schema: sources.schema, policies: 'permit (principal, action' };
    expect(() => createAuthzEngine(bad)).toThrow(AuthzPolicyLoadError);
  });

  it('refuses to start on a policy that references an attribute the schema does not declare', () => {
    const bad: AuthzSources = {
      schema: sources.schema,
      policies: 'permit (principal is User, action, resource) when { principal.nope == "x" };',
    };
    expect(() => createAuthzEngine(bad)).toThrow(AuthzPolicyLoadError);
  });

  it('refuses to start on an invalid schema', () => {
    expect(() => createAuthzEngine({ schema: 'entity {', policies: sources.policies })).toThrow(
      AuthzPolicyLoadError,
    );
  });

  it('returns a deny (not an allow) from an engine whose policies contain a permit-everything rule removed', () => {
    const engine = createAuthzEngine({ schema: sources.schema, policies: '' });
    expect(engine.can(owner(), 'asset:read', assetOwnedBy('user-owner')).allow).toBe(false);
  });
});
