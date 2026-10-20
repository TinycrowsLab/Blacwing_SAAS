import { describe, expect, it } from 'vitest';

import { createCedarKillPolicy, KILL_POLICY_SET, KillPolicyLoadError } from './policy.js';

const T1 = 'tenant-1';
const T2 = 'tenant-2';
const ME = 'user-me';
const policy = createCedarKillPolicy();

const who = (roles: readonly string[], tenantId = T1) => ({ userId: ME, tenantId, roles });

/** Cedar decision vectors: role x scope x ownership x tenant (KILL-003 requirement 4). */
const VECTORS = [
  // [name, roles, resource, expected]
  ['appsec kills a run', ['appsec_engineer'], { scope: 'run', id: 'r1', tenantId: T1 }, 'allow'],
  ['org_admin kills a run', ['org_admin'], { scope: 'run', id: 'r1', tenantId: T1 }, 'allow'],
  [
    'asset_owner cannot kill a run',
    ['asset_owner'],
    { scope: 'run', id: 'r1', tenantId: T1 },
    'deny',
  ],
  [
    'appsec kills any asset',
    ['appsec_engineer'],
    { scope: 'asset', id: 'a1', tenantId: T1, ownerUserIds: [] },
    'allow',
  ],
  [
    'asset_owner kills an owned asset',
    ['asset_owner'],
    { scope: 'asset', id: 'a1', tenantId: T1, ownerUserIds: [ME] },
    'allow',
  ],
  [
    'asset_owner cannot kill an unowned asset',
    ['asset_owner'],
    { scope: 'asset', id: 'a1', tenantId: T1, ownerUserIds: ['someone'] },
    'deny',
  ],
  [
    'asset_owner with no owner list is denied',
    ['asset_owner'],
    { scope: 'asset', id: 'a1', tenantId: T1 },
    'deny',
  ],
  ['org_admin kills the tenant', ['org_admin'], { scope: 'tenant', id: T1, tenantId: T1 }, 'allow'],
  [
    'appsec cannot kill the tenant',
    ['appsec_engineer'],
    { scope: 'tenant', id: T1, tenantId: T1 },
    'deny',
  ],
  [
    'asset_owner cannot kill the tenant',
    ['asset_owner'],
    { scope: 'tenant', id: T1, tenantId: T1 },
    'deny',
  ],
  [
    'developer cannot kill anything',
    ['developer'],
    { scope: 'run', id: 'r1', tenantId: T1 },
    'deny',
  ],
  [
    'no roles is denied',
    [],
    { scope: 'asset', id: 'a1', tenantId: T1, ownerUserIds: [ME] },
    'deny',
  ],
  [
    'cross-tenant run is denied even for org_admin',
    ['org_admin'],
    { scope: 'run', id: 'r1', tenantId: T2 },
    'deny',
  ],
  [
    'cross-tenant owned asset is denied',
    ['asset_owner'],
    { scope: 'asset', id: 'a1', tenantId: T2, ownerUserIds: [ME] },
    'deny',
  ],
  ['another tenant is denied', ['org_admin'], { scope: 'tenant', id: T2, tenantId: T2 }, 'deny'],
] as const;

describe('Cedar Kill::trigger policy', () => {
  it.each(VECTORS)('%s', (_name, roles, resource, expected) => {
    expect(policy.authorize(who(roles), resource).decision).toBe(expected);
  });

  it('names the permitting policy in the decision', () => {
    const decision = policy.authorize(who(['org_admin']), {
      scope: 'tenant',
      id: T1,
      tenantId: T1,
    });
    expect(decision.reasons).toEqual(['kill.tenant']);
  });

  it('is deterministic for the same input (§8.11)', () => {
    const resource = { scope: 'asset', id: 'a1', tenantId: T1, ownerUserIds: [ME] } as const;
    const first = policy.authorize(who(['asset_owner']), resource);
    for (let i = 0; i < 20; i += 1)
      expect(policy.authorize(who(['asset_owner']), resource)).toEqual(first);
  });

  it('denies (fails closed) when a policy errors at evaluation time', () => {
    const erroring = createCedarKillPolicy(
      `${KILL_POLICY_SET}\n@id("broken") permit (principal, action, resource) when { resource.missingAttr == 1 };`,
    );
    const decision = erroring.authorize(who(['appsec_engineer']), {
      scope: 'run',
      id: 'r1',
      tenantId: T1,
    });
    expect(decision.decision).toBe('deny');
    expect(decision.errors.length).toBeGreaterThan(0);
  });

  it('refuses to construct from an unparsable policy set (no allow-all fallback)', () => {
    expect(() => createCedarKillPolicy('permit (principal, action, resource')).toThrow(
      KillPolicyLoadError,
    );
  });
});
