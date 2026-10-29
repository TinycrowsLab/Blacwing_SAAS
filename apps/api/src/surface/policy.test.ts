import { describe, expect, it } from 'vitest';

import { OTHER_TENANT, OTHER_USER, RUN, TENANT, USER } from './fixtures.test-helpers.js';
import { createCedarSurfacePolicy, SURFACE_POLICY_SET, SurfacePolicyLoadError } from './policy.js';

const engine = createCedarSurfacePolicy();
const run = { id: RUN, tenantId: TENANT, ownerUserIds: [USER] };

describe('surface read policy (Cedar)', () => {
  it('allows a tenant role to read any run of its own tenant', () => {
    expect(
      engine.allows({ userId: OTHER_USER, tenantId: TENANT, roles: ['appsec_engineer'] }, run),
    ).toBe(true);
    expect(engine.allows({ userId: OTHER_USER, tenantId: TENANT, roles: ['org_admin'] }, run)).toBe(
      true,
    );
  });

  it('denies a caller of another tenant, whatever their role', () => {
    expect(engine.allows({ userId: USER, tenantId: OTHER_TENANT, roles: ['org_admin'] }, run)).toBe(
      false,
    );
  });

  it('lets an asset owner read the runs of assets they own', () => {
    expect(engine.allows({ userId: USER, tenantId: TENANT, roles: ['asset_owner'] }, run)).toBe(
      true,
    );
  });

  it('denies an asset owner the runs of assets they do not own', () => {
    expect(
      engine.allows({ userId: OTHER_USER, tenantId: TENANT, roles: ['asset_owner'] }, run),
    ).toBe(false);
  });

  it('refuses a run whose tenant differs from the caller even when the run lists the caller as owner', () => {
    const foreign = { id: RUN, tenantId: OTHER_TENANT, ownerUserIds: [USER] };
    expect(engine.allows({ userId: USER, tenantId: TENANT, roles: ['org_admin'] }, foreign)).toBe(
      false,
    );
  });

  it('fails closed at construction on a policy set that does not parse', () => {
    expect(() => createCedarSurfacePolicy('permit (principal, action, resource) when {')).toThrow(
      SurfacePolicyLoadError,
    );
  });

  it('fails closed at construction on a duplicate policy id', () => {
    const duplicated = `${SURFACE_POLICY_SET}\n${SURFACE_POLICY_SET}`;
    expect(() => createCedarSurfacePolicy(duplicated)).toThrow(/duplicate policy id/);
  });
});
