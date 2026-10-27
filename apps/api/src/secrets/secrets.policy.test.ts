import { describe, expect, it } from 'vitest';

import {
  createCedarSecretPolicy,
  SECRET_POLICY_SET,
  SECRET_READ_META_ACTION,
  SECRET_WRITE_ACTION,
  SecretPolicyLoadError,
} from './policy.js';

const TENANT_A = '0190f6a2-7b1c-7d2e-8f3a-123456789abc';
const TENANT_B = '0190f6a2-7b1c-7d2e-8f3a-123456789abd';
const asAdmin = { userId: 'u1', tenantId: TENANT_A, roles: ['org_admin'] };

describe('secret Cedar policy', () => {
  const policy = createCedarSecretPolicy();

  it.each([SECRET_WRITE_ACTION, SECRET_READ_META_ACTION] as const)(
    'allows %s on a secret of the principal tenant',
    (action) => {
      expect(policy.authorize(asAdmin, action, { id: 's1', tenantId: TENANT_A })).toEqual({
        decision: 'allow',
        errors: [],
      });
    },
  );

  it.each([SECRET_WRITE_ACTION, SECRET_READ_META_ACTION] as const)(
    'denies %s on a secret of another tenant, whatever the role',
    (action) => {
      expect(policy.authorize(asAdmin, action, { id: 's1', tenantId: TENANT_B }).decision).toBe(
        'deny',
      );
    },
  );

  it('is deterministic: the same inputs give the same decision', () => {
    const decisions = Array.from({ length: 5 }, () =>
      policy.authorize(asAdmin, SECRET_WRITE_ACTION, { id: 's1', tenantId: TENANT_A }),
    );
    expect(new Set(decisions.map((d) => d.decision))).toEqual(new Set(['allow']));
  });

  it('refuses to start on a policy set that does not parse (fail closed)', () => {
    expect(() => createCedarSecretPolicy('permit (principal, action')).toThrow(
      SecretPolicyLoadError,
    );
  });

  it('denies when a policy errors at evaluation instead of guessing', () => {
    const erroring = createCedarSecretPolicy(`${SECRET_POLICY_SET}
@id("secret.bad")
permit (principal, action, resource is Secret) when { resource.missingAttribute == 1 };`);
    const answer = erroring.authorize(asAdmin, SECRET_WRITE_ACTION, {
      id: 's1',
      tenantId: TENANT_A,
    });
    expect(answer.decision).toBe('deny');
    expect(answer.errors.length).toBeGreaterThan(0);
  });

  it('denies an action outside the secret actions (default deny)', () => {
    const other = policy.authorize(asAdmin, 'Secret::read_value' as never, {
      id: 's1',
      tenantId: TENANT_A,
    });
    expect(other.decision).toBe('deny');
  });
});
