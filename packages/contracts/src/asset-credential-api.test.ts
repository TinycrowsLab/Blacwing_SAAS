import { describe, expect, it } from 'vitest';

import {
  assetCredentialSecretsSchema,
  createAssetCredentialBodySchema,
  assetLoginRecipeSchema,
  missingCredentialSecrets,
  rotateAssetCredentialBodySchema,
} from './asset-credential-api.js';

const form = {
  type: 'form',
  loginUrl: 'https://portal.example.com/login',
  usernameField: 'input[name=user]',
  passwordField: 'input[name=pass]',
  submitSelector: 'button[type=submit]',
  successCheck: '.dashboard',
} as const;

const body = (overrides: Record<string, unknown> = {}) => ({
  roleName: 'admin',
  loginRecipe: form,
  secrets: { username: 'admin', password: 'hunter2' },
  ...overrides,
});

describe('assetLoginRecipeSchema', () => {
  it('accepts each of the five recipe types with its own fields', () => {
    const recipes = [
      form,
      { type: 'http_basic' },
      { type: 'bearer_header', headerName: 'Authorization' },
      {
        type: 'oauth_password',
        tokenUrl: 'https://auth.example.com/token',
        clientRef: 'client-main',
      },
      { type: 'custom_script', scriptRef: 'scripts/portal-login' },
    ];
    for (const recipe of recipes)
      expect(assetLoginRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  it('lower-cases a bearer header name, so the stored recipe is canonical', () => {
    expect(
      assetLoginRecipeSchema.parse({ type: 'bearer_header', headerName: 'X-Api-Token' }),
    ).toEqual({
      type: 'bearer_header',
      headerName: 'x-api-token',
    });
  });

  it('refuses an unknown type, an unknown key and a missing field of a known type', () => {
    expect(assetLoginRecipeSchema.safeParse({ type: 'telnet' }).success).toBe(false);
    expect(assetLoginRecipeSchema.safeParse({ type: 'http_basic', password: 'x' }).success).toBe(
      false,
    );
    const missing: Record<string, unknown> = { ...form };
    delete missing.passwordField;
    expect(assetLoginRecipeSchema.safeParse(missing).success).toBe(false);
  });

  it('refuses a login URL that is not http(s) or that embeds credentials (no plaintext in the recipe)', () => {
    expect(
      assetLoginRecipeSchema.safeParse({ ...form, loginUrl: 'file:///etc/passwd' }).success,
    ).toBe(false);
    expect(
      assetLoginRecipeSchema.safeParse({ ...form, loginUrl: 'data:text/html,<b>x</b>' }).success,
    ).toBe(false);
    expect(
      assetLoginRecipeSchema.safeParse({
        ...form,
        loginUrl: 'https://u:p4ss@portal.example.com/login',
      }).success,
    ).toBe(false);
    expect(
      assetLoginRecipeSchema.safeParse({
        type: 'oauth_password',
        tokenUrl: 'https://svc:p4ss@auth.example.com/token',
        clientRef: 'c',
      }).success,
    ).toBe(false);
  });

  it('refuses a selector with whitespace or a control character, and a bad header name', () => {
    expect(assetLoginRecipeSchema.safeParse({ ...form, usernameField: 'a b' }).success).toBe(false);
    expect(assetLoginRecipeSchema.safeParse({ ...form, submitSelector: 'x\u0007' }).success).toBe(
      false,
    );
    expect(
      assetLoginRecipeSchema.safeParse({ type: 'bearer_header', headerName: 'Bad Header' }).success,
    ).toBe(false);
  });
});

describe('missingCredentialSecrets', () => {
  it('needs a username and a password for form, HTTP basic and OAuth password', () => {
    expect(missingCredentialSecrets(form, 'none', { password: 'p' })).toEqual(['secrets.username']);
    expect(missingCredentialSecrets({ type: 'http_basic' }, 'none', { username: 'u' })).toEqual([
      'secrets.password',
    ]);
    expect(
      missingCredentialSecrets(
        { type: 'oauth_password', tokenUrl: 'https://a.example.com/t', clientRef: 'c' },
        'none',
        {},
      ),
    ).toEqual(['secrets.username', 'secrets.password']);
  });

  it('needs a token for a bearer header and a seed for TOTP, and nothing extra for a script', () => {
    expect(
      missingCredentialSecrets({ type: 'bearer_header', headerName: 'x-a' }, 'none', {}),
    ).toEqual(['secrets.token']);
    expect(missingCredentialSecrets({ type: 'custom_script', scriptRef: 's' }, 'none', {})).toEqual(
      [],
    );
    expect(missingCredentialSecrets({ type: 'custom_script', scriptRef: 's' }, 'totp', {})).toEqual(
      ['secrets.totpSeed'],
    );
    expect(
      missingCredentialSecrets(form, 'totp', { username: 'u', password: 'p', totpSeed: 'JBSW' }),
    ).toEqual([]);
  });
});

describe('createAssetCredentialBodySchema', () => {
  it('defaults the MFA type to none and parses a complete body', () => {
    expect(createAssetCredentialBodySchema.parse(body()).mfaType).toBe('none');
  });

  it('refuses an unknown MFA type, an unknown top-level key, and a secret key outside the set', () => {
    expect(
      createAssetCredentialBodySchema.safeParse(body({ mfaType: 'carrier-pigeon' })).success,
    ).toBe(false);
    expect(createAssetCredentialBodySchema.safeParse(body({ tenantId: 'x' })).success).toBe(false);
    expect(
      createAssetCredentialBodySchema.safeParse(body({ secrets: { username: 'u', pin: '1' } }))
        .success,
    ).toBe(false);
  });

  it('keeps a password exactly as sent (whitespace is part of it) and refuses an empty one', () => {
    const parsed = assetCredentialSecretsSchema.parse({ password: '  spaced  ' });
    expect(parsed.password).toBe('  spaced  ');
    expect(assetCredentialSecretsSchema.safeParse({ password: '' }).success).toBe(false);
  });

  it('requires a non-empty role name', () => {
    expect(createAssetCredentialBodySchema.safeParse(body({ roleName: '   ' })).success).toBe(
      false,
    );
  });
});

describe('rotateAssetCredentialBodySchema', () => {
  it('takes only a complete secret set', () => {
    expect(rotateAssetCredentialBodySchema.safeParse({ secrets: { token: 't' } }).success).toBe(
      true,
    );
    expect(
      rotateAssetCredentialBodySchema.safeParse({ secrets: {}, loginRecipe: form }).success,
    ).toBe(false);
  });
});
