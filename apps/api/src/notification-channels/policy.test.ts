import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCedarChannelPolicy } from './policy.js';

const TENANT = randomUUID();
const OTHER = randomUUID();
const USER = randomUUID();

const engine = createCedarChannelPolicy();

describe('Cedar channel policy (NOTIFY-001)', () => {
  it('allows a principal with the grant in the same tenant', () => {
    const decision = engine.authorize(
      {
        userId: USER,
        tenantId: TENANT,
        roles: ['org_admin'],
        permissions: ['notifications:manage'],
      },
      TENANT,
    );
    expect(decision.decision).toBe('allow');
  });

  it('denies a principal without the grant (deny by default)', () => {
    const decision = engine.authorize(
      { userId: USER, tenantId: TENANT, roles: ['developer'], permissions: ['run:read'] },
      TENANT,
    );
    expect(decision.decision).toBe('deny');
  });

  it('denies a cross-tenant resource even when the grant is present', () => {
    const decision = engine.authorize(
      {
        userId: USER,
        tenantId: TENANT,
        roles: ['org_admin'],
        permissions: ['notifications:manage'],
      },
      OTHER,
    );
    expect(decision.decision).toBe('deny');
  });

  it('refuses to load a malformed policy set (fail closed)', () => {
    expect(() => createCedarChannelPolicy('permit (principal, action, resource')).toThrow();
  });
});
