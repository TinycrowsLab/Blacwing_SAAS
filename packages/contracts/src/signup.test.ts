import { describe, expect, it } from 'vitest';

import {
  SIGNUP_ORG_NAME_MAX,
  signupAcceptedSchema,
  signupRequestSchema,
  signupVerifiedSchema,
  signupVerifyRequestSchema,
} from './signup.js';

const valid = { email: 'owner@example.test', orgName: 'Acme Security' };

describe('signupRequestSchema', () => {
  it('accepts an e-mail and an organisation name', () => {
    expect(signupRequestSchema.parse(valid)).toEqual(valid);
  });

  it('trims and NFC-normalises the organisation name', () => {
    const decomposed = 'Café Sécurité';
    const parsed = signupRequestSchema.parse({ ...valid, orgName: `  ${decomposed}  ` });
    expect(parsed.orgName).toBe(decomposed.normalize('NFC'));
  });

  it.each([
    ['too short after trimming', ' a '],
    ['empty', ''],
    ['too long', 'x'.repeat(SIGNUP_ORG_NAME_MAX + 1)],
    ['a line break', 'Acme\r\nBcc: evil@example.test'],
    ['a bidi override', 'Acme‮gnp'],
    ['a zero-width joiner', 'Ac‍me'],
  ])('rejects an organisation name that is %s', (_label, orgName) => {
    expect(signupRequestSchema.safeParse({ ...valid, orgName }).success).toBe(false);
  });

  it('accepts the length bounds', () => {
    expect(signupRequestSchema.safeParse({ ...valid, orgName: 'ab' }).success).toBe(true);
    expect(
      signupRequestSchema.safeParse({ ...valid, orgName: 'x'.repeat(SIGNUP_ORG_NAME_MAX) }).success,
    ).toBe(true);
  });

  it.each(['not-an-email', '', 'a@b', `${'a'.repeat(320)}@example.test`])(
    'rejects the e-mail %j',
    (email) => {
      expect(signupRequestSchema.safeParse({ ...valid, email }).success).toBe(false);
    },
  );

  it('rejects unknown members, so a caller cannot smuggle a role or a tenant id in', () => {
    expect(signupRequestSchema.safeParse({ ...valid, role: 'org_admin' }).success).toBe(false);
    expect(signupRequestSchema.safeParse({ ...valid, tenantId: 'x' }).success).toBe(false);
  });
});

describe('signupVerifyRequestSchema', () => {
  it('accepts a token and nothing else', () => {
    expect(signupVerifyRequestSchema.safeParse({ token: 'abc' }).success).toBe(true);
    expect(signupVerifyRequestSchema.safeParse({ token: '' }).success).toBe(false);
    expect(signupVerifyRequestSchema.safeParse({ token: 'x'.repeat(513) }).success).toBe(false);
    expect(signupVerifyRequestSchema.safeParse({ token: 'abc', email: 'a@b.test' }).success).toBe(
      false,
    );
  });
});

describe('responses', () => {
  it('has one accepted body, so a signup cannot reveal whether the address exists', () => {
    expect(signupAcceptedSchema.parse({ status: 'verification_requested' })).toEqual({
      status: 'verification_requested',
    });
    expect(
      signupAcceptedSchema.safeParse({ status: 'verification_requested', exists: true }).success,
    ).toBe(false);
  });

  it('distinguishes a created tenant from an existing account', () => {
    expect(
      signupVerifiedSchema.safeParse({
        outcome: 'tenant_created',
        tenantId: '01890a5d-ac96-774b-bcce-b302099a8057',
        slug: 'acme',
      }).success,
    ).toBe(true);
    expect(signupVerifiedSchema.safeParse({ outcome: 'existing_account' }).success).toBe(true);
    expect(signupVerifiedSchema.safeParse({ outcome: 'tenant_created' }).success).toBe(false);
  });
});
