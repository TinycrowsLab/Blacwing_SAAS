import { describe, expect, it } from 'vitest';

import {
  CATALOGUE_VERSION,
  PERMISSIONS,
  PLATFORM_OPERATOR,
  ROLE_PERMISSIONS,
  ROLES,
} from '@blackwing/contracts';

import * as domain from '../index.js';
import {
  effectivePermissions,
  hasPermission,
  knownRoles,
  permissionsForRoles,
  type RbacWarnSink,
  satisfies,
  UNKNOWN_ROLE_WARNING,
} from './permissions.js';

const recorder = (): RbacWarnSink & { calls: [Readonly<Record<string, unknown>>, string][] } => {
  const calls: [Readonly<Record<string, unknown>>, string][] = [];
  return {
    calls,
    warn(fields, message) {
      calls.push([fields, message]);
    },
  };
};

describe('permissionsForRoles / hasPermission (RBAC-001)', () => {
  it('auditor gets only *:read permissions (incl. audit:read), no write/approve', () => {
    const perms = [...permissionsForRoles(['auditor'])];
    expect(perms.length).toBeGreaterThan(0);
    for (const permission of perms) expect(permission).toMatch(/^[a-z_]+:read$/);
    expect(perms).toContain('audit:read');
    expect(hasPermission(['auditor'], 'sa:approve')).toBe(false);
    expect(hasPermission(['auditor'], 'asset:write')).toBe(false);
  });

  it('ci_pipeline lacks approval, triage and release permissions', () => {
    for (const permission of [
      'sa:approve',
      'testplan:approve',
      'gate:decide',
      'finding:triage',
      'finding:release',
    ] as const) {
      expect(hasPermission(['ci_pipeline'], permission), permission).toBe(false);
    }
    expect(hasPermission(['ci_pipeline'], 'run:create')).toBe(true);
  });

  it('edge: empty roles -> empty set, denies everything', () => {
    expect(permissionsForRoles([]).size).toBe(0);
    for (const permission of PERMISSIONS) expect(hasPermission([], permission)).toBe(false);
  });

  it('edge: multiple roles -> union of their permissions', () => {
    const union = permissionsForRoles(['developer', 'auditor']);
    const expected = new Set([...ROLE_PERMISSIONS.developer, ...ROLE_PERMISSIONS.auditor]);
    expect(union).toEqual(expected);
    expect(union.has('run:create')).toBe(true); // developer only
    expect(union.has('audit:read')).toBe(true); // auditor only
    expect(union.has('finding:release')).toBe(false); // neither
  });

  it('union of every role equals the full catalogue; duplicates in input are harmless', () => {
    expect(permissionsForRoles([...ROLES, ...ROLES])).toEqual(new Set(PERMISSIONS));
    expect(permissionsForRoles(['auditor', 'auditor'])).toEqual(new Set(ROLE_PERMISSIONS.auditor));
  });

  it('edge: unknown role is ignored, logs a warning and never grants by default', () => {
    const logger = recorder();
    const perms = permissionsForRoles(['superuser', 'auditor', 'Org_Admin', PLATFORM_OPERATOR], {
      logger,
    });
    expect(perms).toEqual(new Set(ROLE_PERMISSIONS.auditor));
    expect(logger.calls.map(([fields]) => fields.role)).toEqual([
      'superuser',
      'Org_Admin',
      PLATFORM_OPERATOR,
    ]);
    for (const [fields, message] of logger.calls) {
      expect(message).toBe(UNKNOWN_ROLE_WARNING);
      expect(fields.catalogueVersion).toBe(CATALOGUE_VERSION);
    }
  });

  it('edge: only unknown roles -> empty set (deny), even for read permissions', () => {
    const logger = recorder();
    expect(permissionsForRoles(['admin', '*', ''], { logger }).size).toBe(0);
    expect(hasPermission(['admin'], 'asset:read', { logger })).toBe(false);
    expect(logger.calls).toHaveLength(4);
  });

  it('works without a logger and truncates oversized unknown role values in warnings', () => {
    expect(permissionsForRoles(['nope']).size).toBe(0);
    const logger = recorder();
    permissionsForRoles(['x'.repeat(1000)], { logger });
    expect(String(logger.calls[0]?.[0].role)).toHaveLength(64);
  });

  it('platform_operator can never gain tenant permissions through roles', () => {
    for (const permission of PERMISSIONS)
      expect(hasPermission([PLATFORM_OPERATOR], permission)).toBe(false);
  });

  it('returned set is a fresh copy; mutating it does not affect later calls', () => {
    const first = permissionsForRoles(['auditor']) as Set<string>;
    first.add('member:assign');
    expect(hasPermission(['auditor'], 'member:assign')).toBe(false);
  });

  it('knownRoles drops unknown values and duplicates', () => {
    expect(knownRoles(['auditor', 'x', 'auditor', 'developer', PLATFORM_OPERATOR])).toEqual([
      'auditor',
      'developer',
    ]);
  });

  it('is exported from the package root', () => {
    expect(domain.permissionsForRoles).toBe(permissionsForRoles);
    expect(domain.hasPermission).toBe(hasPermission);
    expect(domain.effectivePermissions).toBe(effectivePermissions);
    expect(domain.satisfies).toBe(satisfies);
  });
});

describe('effectivePermissions (RBAC-003)', () => {
  it('a session holds the union of its roles, and its OAuth scopes never narrow it', () => {
    const session = effectivePermissions({
      actorType: 'user',
      roles: ['developer'],
      scopes: ['openid', 'profile'],
    });
    expect(session).toEqual(new Set(ROLE_PERMISSIONS.developer));
    expect(effectivePermissions({ actorType: 'user', roles: ['developer'] })).toEqual(session);
  });

  it('a token is limited to the intersection of its scopes and its owner roles', () => {
    const token = effectivePermissions({
      actorType: 'service',
      roles: ['developer'],
      scopes: ['run:create', 'finding:release', 'asset:read'],
    });
    const ownerHas: readonly string[] = ROLE_PERMISSIONS.developer;
    const expected = ['run:create', 'finding:release', 'asset:read'].filter((p) =>
      ownerHas.includes(p),
    );
    expect([...token].sort()).toEqual(expected.sort());
    expect(token.has('finding:release')).toBe(false);
  });

  it('a token scope the owner roles lack is never granted (no privilege amplification)', () => {
    const token = effectivePermissions({
      actorType: 'service',
      roles: ['auditor'],
      scopes: ['sa:approve', 'audit:read'],
    });
    expect([...token]).toEqual(['audit:read']);
  });

  it('a token without scopes holds nothing, and so does a run or service with no roles', () => {
    expect(effectivePermissions({ actorType: 'service', roles: ['admin'] }).size).toBe(0);
    expect(
      effectivePermissions({ actorType: 'service', roles: ['developer'], scopes: [] }).size,
    ).toBe(0);
    expect(
      effectivePermissions({ actorType: 'run', roles: ['developer'], scopes: ['run:create'] }).has(
        'run:create',
      ),
    ).toBe(true);
    expect(effectivePermissions({ actorType: 'user', roles: [] }).size).toBe(0);
  });

  it('unknown scope strings and unknown roles grant nothing', () => {
    expect(
      effectivePermissions({
        actorType: 'service',
        roles: ['developer'],
        scopes: ['*', 'run:*', 'nope:nope'],
      }).size,
    ).toBe(0);
    expect(effectivePermissions({ actorType: 'user', roles: ['superuser'] }).size).toBe(0);
  });
});

describe('satisfies (RBAC-003)', () => {
  const granted = new Set(['run:create', 'asset:read'] as const);

  it('"all" needs every listed permission and "any" needs one', () => {
    expect(satisfies(granted, { mode: 'all', permissions: ['run:create', 'asset:read'] })).toBe(
      true,
    );
    expect(satisfies(granted, { mode: 'all', permissions: ['run:create', 'sa:approve'] })).toBe(
      false,
    );
    expect(satisfies(granted, { mode: 'any', permissions: ['sa:approve', 'asset:read'] })).toBe(
      true,
    );
    expect(satisfies(granted, { mode: 'any', permissions: ['sa:approve'] })).toBe(false);
  });

  it('an empty requirement is never satisfied (deny by default)', () => {
    expect(satisfies(granted, { mode: 'all', permissions: [] })).toBe(false);
    expect(satisfies(granted, { mode: 'any', permissions: [] })).toBe(false);
    expect(satisfies(new Set(), { mode: 'all', permissions: ['run:create'] })).toBe(false);
  });
});
