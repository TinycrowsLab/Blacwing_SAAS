import { describe, expect, it } from 'vitest';

import { isConfigValidationError } from '@blackwing/config';

import { loadAuthConfig } from './config.js';

const secret = 'a'.repeat(32);
const env = {
  NODE_ENV: 'development',
  KEYCLOAK_ISSUER_URL: 'http://localhost:18080/realms/blackwing-dev/',
  KEYCLOAK_CLIENT_ID: 'bw-console-bff',
  BW_CONSOLE_ORIGIN: 'http://localhost:3000/',
  REDIS_URL: 'redis://127.0.0.1:16379',
  BW_WEB_SESSION_SECRET: secret,
};

function issues(source: Record<string, string>): string[] {
  try {
    loadAuthConfig(source);
  } catch (error) {
    if (isConfigValidationError(error)) return error.issues.map((issue) => issue.key);
    throw error;
  }
  return [];
}

describe('loadAuthConfig', () => {
  it('normalises the issuer and origin and derives the redirect URI', () => {
    const config = loadAuthConfig(env);
    expect(config.issuer).toBe('http://localhost:18080/realms/blackwing-dev');
    expect(config.consoleOrigin).toBe('http://localhost:3000');
    expect(config.redirectUri).toBe('http://localhost:3000/auth/callback');
    expect(config.clientSecret).toBeUndefined();
    expect(config.sessionKeys).toHaveLength(1);
  });

  it('derives distinct 32-byte keys from the secret and the previous secret, and takes a client secret', () => {
    const config = loadAuthConfig({
      ...env,
      BW_WEB_SESSION_SECRET: 'b'.repeat(40),
      BW_WEB_SESSION_SECRET_PREVIOUS: secret,
      KEYCLOAK_CLIENT_SECRET: 'client-secret-value',
    });
    const [current, previous] = config.sessionKeys;
    expect([current.length, previous?.length]).toEqual([32, 32]);
    expect(current.equals(previous ?? current)).toBe(false);
    expect(config.clientSecret).toBe('client-secret-value');
  });

  it('fails closed on every missing required key, naming keys and never values', () => {
    for (const missing of Object.keys(env)) {
      const rest = Object.fromEntries(Object.entries(env).filter(([key]) => key !== missing));
      expect(issues(rest)).toContain(missing);
    }
  });

  it('rejects session secrets shorter than 32 characters', () => {
    expect(issues({ ...env, BW_WEB_SESSION_SECRET: 'short' })).toContain('BW_WEB_SESSION_SECRET');
    expect(issues({ ...env, BW_WEB_SESSION_SECRET_PREVIOUS: 'x'.repeat(31) })).toContain(
      'BW_WEB_SESSION_SECRET_PREVIOUS',
    );
  });

  it('requires https for the issuer and origin in staging and production only', () => {
    expect(issues({ ...env, NODE_ENV: 'production' }).sort()).toEqual([
      'BW_CONSOLE_ORIGIN',
      'KEYCLOAK_ISSUER_URL',
    ]);
    expect(
      issues({
        ...env,
        NODE_ENV: 'production',
        KEYCLOAK_ISSUER_URL: 'https://id.example.com/realms/blackwing',
        BW_CONSOLE_ORIGIN: 'https://app.example.com',
      }),
    ).toEqual([]);
  });
});

describe('loadAuthConfig session admin client (#336)', () => {
  it('is absent when neither value is set, and present when both are', () => {
    expect(loadAuthConfig(env).sessionAdmin).toBeUndefined();
    const config = loadAuthConfig({
      ...env,
      KEYCLOAK_SESSION_ADMIN_CLIENT_ID: 'bw-session-admin',
      KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET: 'x'.repeat(24),
    });
    expect(config.sessionAdmin).toEqual({
      clientId: 'bw-session-admin',
      clientSecret: 'x'.repeat(24),
    });
  });

  it('refuses a half-configured admin client, naming the missing key only', () => {
    expect(issues({ ...env, KEYCLOAK_SESSION_ADMIN_CLIENT_ID: 'bw-session-admin' })).toEqual([
      'KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET',
    ]);
    expect(issues({ ...env, KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET: 'x'.repeat(24) })).toEqual([
      'KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET',
    ]);
  });
});
