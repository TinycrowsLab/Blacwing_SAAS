import { describe, expect, it } from 'vitest';

import { AppError, ForbiddenError } from '@blackwing/errors';

import { checkResource } from './check.js';

import type { AuthzDecisionLog } from '../index.js';
import type { AuthzPrincipal, AuthzResource } from './entities.js';

interface Recorded {
  readonly level: 'debug' | 'warn';
  readonly fields: unknown;
  readonly message: string;
}

/** Records every decision log call so tests can assert what is (and is not) logged. */
function recorder(): { log: AuthzDecisionLog; entries: Recorded[] } {
  const entries: Recorded[] = [];
  const log: AuthzDecisionLog = {
    debug: (fields: unknown, message?: string) => {
      entries.push({ level: 'debug', fields, message: message ?? '' });
    },
    warn: (fields: unknown, message?: string) => {
      entries.push({ level: 'warn', fields, message: message ?? '' });
    },
  };
  return { log, entries };
}

const TENANT = 'tenant-a';
const owner: AuthzPrincipal = {
  kind: 'user',
  tenantId: TENANT,
  userId: 'user-owner',
  roles: ['asset_owner'],
};
const ownedAsset: AuthzResource = {
  kind: 'asset',
  tenantId: TENANT,
  assetId: 'asset-1',
  ownerUserId: 'user-owner',
};

describe('checkResource (#345): deny-closed resource check', () => {
  it('returns without error when Cedar allows, and logs the decision at debug', () => {
    const { log, entries } = recorder();
    expect(() => {
      checkResource(owner, 'asset:read', ownedAsset, log);
    }).not.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('debug');
    expect(entries[0]?.message).toBe('cedar.decision');
    expect(entries[0]?.fields).toMatchObject({
      action: 'asset:read',
      resourceType: 'asset',
      decision: 'allow',
    });
  });

  it('throws FORBIDDEN with no detail when the caller does not own the asset (IDOR)', () => {
    const { log } = recorder();
    const notMine: AuthzResource = { ...ownedAsset, ownerUserId: 'someone-else' };
    let caught: unknown;
    try {
      checkResource(owner, 'asset:write', notMine, log);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as ForbiddenError).code).toBe('FORBIDDEN');
    expect((caught as ForbiddenError).message).toBe('Forbidden');
  });

  it('throws on a cross-tenant resource even when the owner id matches', () => {
    const { log } = recorder();
    const otherTenant: AuthzResource = { ...ownedAsset, tenantId: 'tenant-b' };
    expect(() => {
      checkResource(owner, 'asset:read', otherTenant, log);
    }).toThrow(ForbiddenError);
  });

  it('logs a deny at warn with the deciding policy id and no user or tenant identifiers', () => {
    const { log, entries } = recorder();
    expect(() => {
      checkResource(owner, 'asset:read', { ...ownedAsset, tenantId: 'tenant-b' }, log);
    }).toThrow(ForbiddenError);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('warn');
    expect(entries[0]?.fields).toMatchObject({
      action: 'asset:read',
      resourceType: 'asset',
      decision: 'deny',
      reason: 'authz.tenant_isolation',
    });
    const serialised = JSON.stringify(entries[0]?.fields);
    expect(serialised).not.toContain('user-owner');
    expect(serialised).not.toContain(TENANT);
    expect(serialised).not.toContain('tenant-b');
  });

  it('reports no_matching_permit when no policy grants the action', () => {
    const { log, entries } = recorder();
    expect(() => {
      checkResource(
        { ...owner, roles: [] },
        'asset:write',
        { ...ownedAsset, ownerUserId: 'x' },
        log,
      );
    }).toThrow(ForbiddenError);
    expect(entries[0]?.fields).toMatchObject({ reason: 'no_matching_permit', decision: 'deny' });
  });

  it('denies and reports evaluation_error when the resource is missing an attribute', () => {
    const { log, entries } = recorder();
    const broken = {
      kind: 'asset',
      tenantId: TENANT,
      assetId: 'asset-1',
    } as unknown as AuthzResource;
    expect(() => {
      checkResource(owner, 'asset:read', broken, log);
    }).toThrow(ForbiddenError);
    expect(entries[0]?.fields).toMatchObject({ decision: 'deny' });
  });
});
