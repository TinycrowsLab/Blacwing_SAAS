import { describe, expect, it } from 'vitest';

import { isConfigValidationError } from '@blackwing/config';

import { loadOperatorAuthConfig } from './config.js';

const secret = 'a'.repeat(32);
const env = {
  NODE_ENV: 'development',
  OPERATOR_KEYCLOAK_ISSUER_URL: 'http://localhost:18080/realms/blackwing-operators/',
  OPERATOR_KEYCLOAK_CLIENT_ID: 'operator-bff',
  OPERATOR_KEYCLOAK_CLIENT_SECRET: 'operator-client-secret-value',
  BW_CONSOLE_ORIGIN: 'http://localhost:3000/',
  REDIS_URL: 'redis://127.0.0.1:16379',
  BW_OPERATOR_SESSION_SECRET: secret,
};

function issues(source: Record<string, string>): string[] {
  try {
    loadOperatorAuthConfig(source);
  } catch (error) {
    if (isConfigValidationError(error)) return error.issues.map((issue) => issue.key);
    throw error;
  }
  return [];
}

describe('loadOperatorAuthConfig (#838)', () => {
  it('reads the operator realm and client, derives the operator callback and keys', () => {
    const config = loadOperatorAuthConfig(env);
    expect(config.issuer).toBe('http://localhost:18080/realms/blackwing-operators');
    expect(config.clientId).toBe('operator-bff');
    expect(config.clientSecret).toBe('operator-client-secret-value');
    expect(config.consoleOrigin).toBe('http://localhost:3000');
    expect(config.redirectUri).toBe('http://localhost:3000/operator/api/auth/callback');
    expect(config.sessionKeys).toHaveLength(1);
  });

  it('derives the previous operator key for rotation, separate from the tenant secret', () => {
    const config = loadOperatorAuthConfig({
      ...env,
      BW_OPERATOR_SESSION_SECRET: 'b'.repeat(40),
      BW_OPERATOR_SESSION_SECRET_PREVIOUS: secret,
    });
    const [current, previous] = config.sessionKeys;
    expect(current.equals(previous ?? current)).toBe(false);
  });

  it('fails closed on every missing required key, naming keys and never values', () => {
    for (const missing of Object.keys(env)) {
      if (missing === 'NODE_ENV') continue;
      const rest = Object.fromEntries(Object.entries(env).filter(([key]) => key !== missing));
      expect(issues(rest)).toContain(missing);
    }
  });

  it('rejects a short operator session secret', () => {
    expect(issues({ ...env, BW_OPERATOR_SESSION_SECRET: 'short' })).toContain(
      'BW_OPERATOR_SESSION_SECRET',
    );
    expect(issues({ ...env, BW_OPERATOR_SESSION_SECRET_PREVIOUS: 'x'.repeat(31) })).toContain(
      'BW_OPERATOR_SESSION_SECRET_PREVIOUS',
    );
  });

  it('requires https for the operator issuer and the console origin in staging and production', () => {
    const production = { ...env, NODE_ENV: 'production' };
    expect(issues(production)).toEqual(
      expect.arrayContaining(['OPERATOR_KEYCLOAK_ISSUER_URL', 'BW_CONSOLE_ORIGIN']),
    );
    const secure = {
      ...production,
      OPERATOR_KEYCLOAK_ISSUER_URL: 'https://id.example.com/realms/blackwing-operators',
      BW_CONSOLE_ORIGIN: 'https://app.example.com',
    };
    expect(issues(secure)).toEqual([]);
  });
});
