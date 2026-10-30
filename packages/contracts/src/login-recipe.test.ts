import { describe, expect, it } from 'vitest';

import {
  cookieImportRecipeSchema,
  findForbiddenSecretKey,
  formRecipeSchema,
  loginRecipeSchema,
  type LoginRecipe,
  mfaSchema,
  oauth2ClientCredentialsRecipeSchema,
  oidcAuthCodeRecipeSchema,
  roleMatrixSchema,
  roleSessionDescriptorSchema,
  SM_RECIPE_INVALID,
  staticHeaderRecipeSchema,
  successCheckSchema,
  type SuccessCheck,
} from './login-recipe.js';

const REF = 'bw-secret://0190f3a4-0000-7000-8000-000000000001/0190f3a4-0000-7000-8000-000000000002';
const REF_V2 = `${REF}?v=2`;
const credentialRef = { secretRef: REF };
const successCheck = { url: 'https://app.example.test/me', expectedStatus: 200 };

const formRecipe = {
  roleName: 'admin',
  kind: 'form',
  loginUrl: 'https://app.example.test/login',
  steps: [
    { action: 'fill_text', selector: '#user', value: 'alice' },
    { action: 'fill_secret', selector: '#pass', credentialRef },
    { action: 'click', selector: 'button[type=submit]' },
  ],
  credentialRef,
  successCheck,
};

const oidcRecipe = {
  roleName: 'viewer',
  kind: 'oidc_auth_code',
  issuer: 'https://idp.example.test',
  clientId: 'blackwing-scanner',
  redirectUri: 'https://app.example.test/callback',
  scopes: ['openid', 'profile'],
  credentialRef,
  successCheck,
};

const clientCredsRecipe = {
  roleName: 'service',
  kind: 'oauth2_client_credentials',
  tokenUrl: 'https://idp.example.test/token',
  clientIdRef: { secretRef: REF },
  clientSecretRef: { secretRef: REF_V2 },
  scopes: ['api.read'],
  successCheck,
};

const staticHeaderRecipe = {
  roleName: 'api-user',
  kind: 'static_header',
  headerName: 'Authorization',
  scheme: 'bearer',
  credentialRef,
  successCheck,
};

const cookieRecipe = {
  roleName: 'cookie-user',
  kind: 'cookie_import',
  cookies: [
    { name: 'session', credentialRef },
    { name: 'csrf', credentialRef: { secretRef: REF_V2 } },
  ],
  successCheck,
};

const ALL_VALID = [formRecipe, oidcRecipe, clientCredsRecipe, staticHeaderRecipe, cookieRecipe];

function parseIssues(value: unknown): string[] {
  const result = loginRecipeSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('loginRecipeSchema: per-kind parse and reject', () => {
  it.each(ALL_VALID.map((recipe) => [recipe.kind, recipe] as const))(
    'parses a valid %s recipe',
    (_kind, recipe) => {
      const result = loginRecipeSchema.safeParse(recipe);
      expect(result.success).toBe(true);
    },
  );

  it('round-trips every kind: parse, serialise, parse again gives the same value', () => {
    for (const recipe of ALL_VALID) {
      const first = loginRecipeSchema.parse(recipe);
      const second = loginRecipeSchema.parse(structuredClone(first));
      expect(second).toEqual(first);
    }
  });

  it('keeps secretRef as a canonical bw-secret string, so the stored shape is plain JSON', () => {
    const parsed: LoginRecipe = loginRecipeSchema.parse(formRecipe);
    expect(parsed.kind).toBe('form');
    if (parsed.kind !== 'form') throw new Error('narrowing');
    expect(parsed.credentialRef.secretRef).toBe(REF);
  });

  it('rejects an unknown kind (discriminated union)', () => {
    expect(loginRecipeSchema.safeParse({ ...formRecipe, kind: 'kerberos' }).success).toBe(false);
  });

  it('rejects a form recipe with no steps', () => {
    expect(formRecipeSchema.safeParse({ ...formRecipe, steps: [] }).success).toBe(false);
  });

  it('rejects an oidc recipe with no scopes', () => {
    expect(oidcAuthCodeRecipeSchema.safeParse({ ...oidcRecipe, scopes: [] }).success).toBe(false);
  });

  it('rejects a static header with a non-header name', () => {
    expect(
      staticHeaderRecipeSchema.safeParse({ ...staticHeaderRecipe, headerName: 'X Bad:Name' })
        .success,
    ).toBe(false);
  });

  it('rejects a static header with an unknown scheme', () => {
    expect(
      staticHeaderRecipeSchema.safeParse({ ...staticHeaderRecipe, scheme: 'digest' }).success,
    ).toBe(false);
  });

  it('rejects a client-credentials recipe whose clientSecretRef is not a ref', () => {
    expect(
      oauth2ClientCredentialsRecipeSchema.safeParse({
        ...clientCredsRecipe,
        clientSecretRef: { secretRef: 'hunter2' },
      }).success,
    ).toBe(false);
  });

  it('rejects a non-http(s) URL such as file: or javascript:', () => {
    expect(
      formRecipeSchema.safeParse({ ...formRecipe, loginUrl: 'file:///etc/passwd' }).success,
    ).toBe(false);
    expect(
      formRecipeSchema.safeParse({ ...formRecipe, loginUrl: 'data:text/html,hello' }).success,
    ).toBe(false);
    expect(formRecipeSchema.safeParse({ ...formRecipe, loginUrl: 'not a url' }).success).toBe(
      false,
    );
  });

  it('rejects an invalid role name', () => {
    expect(loginRecipeSchema.safeParse({ ...formRecipe, roleName: 'Admin User' }).success).toBe(
      false,
    );
  });

  it('rejects a strict-object extra field that is not a secret', () => {
    expect(loginRecipeSchema.safeParse({ ...formRecipe, extra: true }).success).toBe(false);
  });
});

describe('literal secrets are refused with SM_RECIPE_INVALID', () => {
  const forbiddenCases: [string, unknown][] = [
    [
      'form step password',
      { ...formRecipe, steps: [{ action: 'fill_text', selector: '#pass', password: 'hunter2' }] },
    ],
    ['top-level token', { ...formRecipe, token: 'eyJhbGciOi' }],
    ['clientSecret literal', { ...clientCredsRecipe, clientSecret: 'shh' }],
    ['apiKey literal', { ...staticHeaderRecipe, apiKey: 'AKIA123' }],
    ['cookie value', { ...cookieRecipe, cookies: [{ name: 'session', value: 'abc' }] }],
    ['Password in mixed case', { ...formRecipe, Password: 'hunter2' }],
  ];

  it.each(forbiddenCases)('rejects a recipe with a %s', (_label, recipe) => {
    const result = loginRecipeSchema.safeParse(recipe);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.message.startsWith(SM_RECIPE_INVALID))).toBe(
      true,
    );
  });

  it('refuses a literal secret in a plain string where a ref belongs', () => {
    expect(
      loginRecipeSchema.safeParse({ ...formRecipe, credentialRef: { secretRef: 'hunter2' } })
        .success,
    ).toBe(false);
  });

  it('keeps a literal password out of the guard result, even inside a nested cookie list', () => {
    expect(findForbiddenSecretKey({ cookies: [{ name: 'a', nested: { PASSWORD: 'x' } }] })).toBe(
      'PASSWORD',
    );
  });

  it('does not flag ref keys that merely contain secret words', () => {
    expect(findForbiddenSecretKey(clientCredsRecipe)).toBeUndefined();
    expect(parseIssues(clientCredsRecipe)).toEqual([]);
  });
});

describe('MFA refinement', () => {
  it('accepts totp with a secretRef', () => {
    expect(mfaSchema.safeParse({ type: 'totp', secretRef: credentialRef }).success).toBe(true);
  });

  it('rejects totp without a secretRef', () => {
    expect(mfaSchema.safeParse({ type: 'totp' }).success).toBe(false);
  });

  it('accepts none with no secretRef', () => {
    expect(mfaSchema.safeParse({ type: 'none' }).success).toBe(true);
  });

  it('rejects none that still carries a secretRef', () => {
    expect(mfaSchema.safeParse({ type: 'none', secretRef: credentialRef }).success).toBe(false);
  });

  it('accepts a recipe with totp MFA', () => {
    expect(
      loginRecipeSchema.safeParse({
        ...formRecipe,
        mfa: { type: 'totp', secretRef: credentialRef },
      }).success,
    ).toBe(true);
  });
});

describe('SuccessCheck', () => {
  const check: SuccessCheck = { url: 'https://app.example.test/me', selector: '#avatar' };

  it('accepts a status, a selector or a JSON path assertion', () => {
    expect(successCheckSchema.safeParse(check).success).toBe(true);
    expect(successCheckSchema.safeParse({ url: check.url, expectedStatus: 204 }).success).toBe(
      true,
    );
    expect(
      successCheckSchema.safeParse({
        url: check.url,
        jsonPath: { path: '$.user.id', equals: 'u-1' },
      }).success,
    ).toBe(true);
  });

  it('rejects a check that asserts nothing, so it cannot pass everything', () => {
    expect(successCheckSchema.safeParse({ url: 'https://app.example.test/me' }).success).toBe(
      false,
    );
  });

  it('rejects an out-of-range expected status', () => {
    expect(successCheckSchema.safeParse({ url: check.url, expectedStatus: 700 }).success).toBe(
      false,
    );
  });

  it('is enforced inside the recipe schema too', () => {
    expect(loginRecipeSchema.safeParse({ ...formRecipe, successCheck: {} }).success).toBe(false);
  });
});

describe('form steps', () => {
  it('preserves Unicode in selectors and values verbatim', () => {
    const selector = 'input[name="ユーザー名"]';
    const value = 'Zoë 🦊 Ünïcode';
    const parsed = formRecipeSchema.parse({
      ...formRecipe,
      steps: [{ action: 'fill_text', selector, value }],
    });
    expect(parsed.steps[0]).toEqual({ action: 'fill_text', selector, value });
  });

  it('rejects an empty selector', () => {
    expect(
      formRecipeSchema.safeParse({ ...formRecipe, steps: [{ action: 'click', selector: '' }] })
        .success,
    ).toBe(false);
  });
});

describe('cookie_import', () => {
  it('rejects duplicate cookie names', () => {
    const result = cookieImportRecipeSchema.safeParse({
      ...cookieRecipe,
      cookies: [
        { name: 'session', credentialRef },
        { name: 'session', credentialRef: { secretRef: REF_V2 } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('treats cookie names as case-sensitive, so Session and session are distinct', () => {
    expect(
      cookieImportRecipeSchema.safeParse({
        ...cookieRecipe,
        cookies: [
          { name: 'Session', credentialRef },
          { name: 'session', credentialRef },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects an empty cookie list', () => {
    expect(cookieImportRecipeSchema.safeParse({ ...cookieRecipe, cookies: [] }).success).toBe(
      false,
    );
  });

  it('rejects a cookie name that is not an RFC 6265 token', () => {
    expect(
      cookieImportRecipeSchema.safeParse({
        ...cookieRecipe,
        cookies: [{ name: 'bad name;', credentialRef }],
      }).success,
    ).toBe(false);
  });
});

describe('RoleSessionDescriptor', () => {
  const descriptor = {
    tenantId: '0190f3a4-0000-7000-8000-000000000010',
    runId: '0190f3a4-0000-7000-8000-000000000011',
    assetId: '0190f3a4-0000-7000-8000-000000000012',
    roleName: 'admin',
    kind: 'form',
    expiresAt: '2026-10-31T12:00:00.000Z',
  };

  it('parses non-secret session metadata', () => {
    expect(roleSessionDescriptorSchema.safeParse(descriptor).success).toBe(true);
  });

  it('refuses a token or cookie field', () => {
    expect(roleSessionDescriptorSchema.safeParse({ ...descriptor, token: 'x' }).success).toBe(
      false,
    );
  });

  it('refuses a non-ISO expiry', () => {
    expect(
      roleSessionDescriptorSchema.safeParse({ ...descriptor, expiresAt: 'tomorrow' }).success,
    ).toBe(false);
  });
});

describe('RoleMatrix reference type', () => {
  it('maps roles to functions to allow or deny', () => {
    expect(
      roleMatrixSchema.safeParse({
        admin: { 'user.delete': 'allow' },
        viewer: { 'user.delete': 'deny' },
      }).success,
    ).toBe(true);
  });

  it('rejects any other access value', () => {
    expect(roleMatrixSchema.safeParse({ admin: { 'user.delete': 'maybe' } }).success).toBe(false);
  });
});
