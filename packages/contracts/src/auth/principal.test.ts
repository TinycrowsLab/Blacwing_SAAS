import { describe, expect, it } from 'vitest';

import { principalSchema } from './principal.js';

const valid = {
  subjectId: 'usr_01',
  kind: 'user',
  tenantId: '0198f0a0-0000-7000-8000-00000000000a',
  roles: ['tenant_admin'],
  scopes: ['openid'],
  authMethod: 'keycloak_jwt',
};

describe('principalSchema', () => {
  it('accepts the canonical principal of each credential path', () => {
    expect(principalSchema.safeParse(valid).success).toBe(true);
    expect(
      principalSchema.safeParse({ ...valid, kind: 'service', authMethod: 'bff_session', acr: '1' })
        .success,
    ).toBe(true);
  });

  it.each([
    ['an unknown field (no smuggled claims)', { ...valid, tenantSlug: 'acme' }],
    ['a tenant that is not a UUID', { ...valid, tenantId: 'acme' }],
    [
      'an upper-case or padded tenant id',
      { ...valid, tenantId: ' 0198F0A0-0000-7000-8000-00000000000A' },
    ],
    ['an unknown auth method', { ...valid, authMethod: 'none' }],
    ['an unknown kind', { ...valid, kind: 'run' }],
    ['an empty subject', { ...valid, subjectId: '' }],
    ['a missing roles list', { ...valid, roles: undefined }],
    ['a non-string role', { ...valid, roles: [1] }],
    ['an empty scope', { ...valid, scopes: [''] }],
  ])('rejects %s', (_name, candidate) => {
    expect(principalSchema.safeParse(candidate).success).toBe(false);
  });
});
