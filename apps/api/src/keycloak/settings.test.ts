import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import { keycloakAdminSettingsFrom } from './settings.js';

const complete = {
  KEYCLOAK_ADMIN_URL: 'https://id.example.test/',
  KEYCLOAK_ADMIN_REALM: 'blackwing',
  KEYCLOAK_ORG_ADMIN_CLIENT_ID: 'bw-org-admin',
  KEYCLOAK_ORG_ADMIN_SECRET_PATH: 'secret/data/platform/keycloak/org-admin',
};

function refusal(env: Parameters<typeof keycloakAdminSettingsFrom>[0]): AppError {
  try {
    keycloakAdminSettingsFrom(env);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the settings to be refused');
}

describe('keycloakAdminSettingsFrom', () => {
  it('builds the settings and strips trailing slashes from the origin', () => {
    expect(keycloakAdminSettingsFrom(complete)).toEqual({
      baseUrl: 'https://id.example.test',
      realm: 'blackwing',
      clientId: 'bw-org-admin',
      secretPath: 'secret/data/platform/keycloak/org-admin',
    });
  });

  it.each(Object.keys(complete) as (keyof typeof complete)[])(
    'refuses to start when %s is missing (fail closed, no partial configuration)',
    (key) => {
      const env = Object.fromEntries(Object.entries(complete).filter(([name]) => name !== key));
      const error = refusal(env);
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).not.toContain('secret/data');
    },
  );

  it.each([
    ['a path traversal', 'secret/data/../../sys/policies'],
    ['a leading slash', '/secret/data/org-admin'],
    ['a query injection', 'secret/data/org-admin?x=1'],
    ['an empty segment', 'secret//org-admin'],
    ['a dot segment', 'secret/data/./org-admin'],
  ])('refuses a secret path with %s', (_label, secretPath) => {
    expect(refusal({ ...complete, KEYCLOAK_ORG_ADMIN_SECRET_PATH: secretPath }).code).toBe(
      'CONFIG_INVALID',
    );
  });
});
