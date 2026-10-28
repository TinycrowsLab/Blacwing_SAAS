import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ConfigValidationError } from '@blackwing/config';
import { AppError } from '@blackwing/errors';

import {
  DEFAULT_API_BODY_LIMIT_BYTES,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  DEFAULT_API_SHUTDOWN_GRACE_MS,
  loadApiConfig,
} from './config.js';

const minimal = { NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' };

function refusal(source: Record<string, string>): ConfigValidationError {
  try {
    loadApiConfig(source);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error('expected the configuration to be refused');
}

describe('loadApiConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadApiConfig(minimal);
    expect(config.API_PORT).toBe(DEFAULT_API_PORT);
    expect(config.API_HOST).toBe(DEFAULT_API_HOST);
    expect(config.API_BODY_LIMIT_BYTES).toBe(DEFAULT_API_BODY_LIMIT_BYTES);
    expect(config.API_BODY_LIMIT_BYTES).toBe(1_048_576);
    expect(config.API_MAX_JSON_DEPTH).toBe(32);
    expect(config.API_TRUST_PROXY).toBe(true);
    expect(config.API_SHUTDOWN_GRACE_MS).toBe(DEFAULT_API_SHUTDOWN_GRACE_MS);
    expect(config.API_IDEMPOTENCY_TTL_S).toBe(86_400);
    expect(config.API_IDEMPOTENCY_LOCK_TTL_S).toBe(120);
    expect(config.API_IDEMPOTENCY_MAX_BODY_BYTES).toBe(65_536);
    expect(config.API_SSE_HEARTBEAT_MS).toBe(15_000);
    expect(config.API_SSE_MAX_DURATION_MS).toBe(3_600_000);
    expect(config.API_SSE_MAX_REPLAY).toBe(1_000);
    expect(config.API_SSE_MAX_CONN_PER_TENANT).toBe(100);
    expect(config.RATE_LIMIT_DEFAULT_RPS).toBe(10);
    expect(config.RATE_LIMIT_BURST).toBe(20);
    expect(config.SIGNUP_TOKEN_TTL_HOURS).toBe(24);
    expect(config.SIGNUP_DEFAULT_REGION).toBe('eu-west-1');
    expect(config.SIGNUP_EMAIL_MAX_PER_HOUR).toBe(5);
    expect(config.SIGNUP_VERIFY_URL).toBeUndefined();
    expect(config.WEB_ORIGIN).toEqual(['http://localhost:3000']);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses explicit values, including several origins and a false proxy trust', () => {
    const config = loadApiConfig({
      ...minimal,
      API_PORT: '13400',
      API_HOST: '127.0.0.1',
      API_BODY_LIMIT_BYTES: '2048',
      API_TRUST_PROXY: 'false',
      API_SHUTDOWN_GRACE_MS: '5s',
      WEB_ORIGIN: 'http://localhost:3000,https://console.example.test',
    });
    expect(config).toMatchObject({
      API_PORT: 13_400,
      API_HOST: '127.0.0.1',
      API_BODY_LIMIT_BYTES: 2048,
      API_TRUST_PROXY: false,
      API_SHUTDOWN_GRACE_MS: 5000,
    });
    expect(config.WEB_ORIGIN).toEqual(['http://localhost:3000', 'https://console.example.test']);
  });

  it('fails closed when a required key is missing, naming it in an AppError', () => {
    const error = refusal({ WEB_ORIGIN: 'http://localhost:3000' });
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.missingKeys).toEqual(['NODE_ENV']);
    expect(refusal({ NODE_ENV: 'test' }).missingKeys).toEqual(['WEB_ORIGIN']);
  });

  it.each([
    ['API_PORT', '0'],
    ['API_PORT', '70000'],
    ['API_BODY_LIMIT_BYTES', '0'],
    ['API_BODY_LIMIT_BYTES', '-5'],
    ['API_MAX_JSON_DEPTH', '0'],
    ['API_TRUST_PROXY', 'maybe'],
    ['API_SHUTDOWN_GRACE_MS', '0'],
    ['API_IDEMPOTENCY_TTL_S', '0'],
    ['API_IDEMPOTENCY_LOCK_TTL_S', '1.5'],
    ['API_IDEMPOTENCY_MAX_BODY_BYTES', '-1'],
    ['API_SSE_HEARTBEAT_MS', '0'],
    ['API_SSE_MAX_DURATION_MS', 'soon'],
    ['API_SSE_MAX_REPLAY', '0'],
    ['API_SSE_MAX_CONN_PER_TENANT', '-1'],
    ['RATE_LIMIT_DEFAULT_RPS', '0'],
    ['RATE_LIMIT_DEFAULT_RPS', '2.5'],
    ['RATE_LIMIT_BURST', '-3'],
    ['RATE_LIMIT_BURST', '1000000'],
    ['SIGNUP_TOKEN_TTL_HOURS', '0'],
    ['SIGNUP_TOKEN_TTL_HOURS', '169'],
    ['SIGNUP_TOKEN_TTL_HOURS', '1.5'],
    ['SIGNUP_DEFAULT_REGION', 'Europe'],
    ['SIGNUP_EMAIL_MAX_PER_HOUR', '0'],
    ['SIGNUP_VERIFY_URL', 'ftp://files.example/verify'],
    ['WEB_ORIGIN', 'http://localhost:3000/app'],
    ['WEB_ORIGIN', 'http://localhost:3000/'],
    ['WEB_ORIGIN', 'ftp://localhost'],
    ['NODE_ENV', 'qa'],
  ])('refuses an invalid %s (%s) without echoing the value', (key, value) => {
    const error = refusal({ ...minimal, [key]: value });
    expect(error.invalidKeys.map((invalid) => invalid.replace(/\[\d+\]$/, ''))).toEqual([key]);
    expect(error.message).not.toContain(value);
  });

  it('leaves the Keycloak organisation admin keys optional, and validates the admin URL', () => {
    expect(loadApiConfig(minimal).KEYCLOAK_ADMIN_URL).toBeUndefined();
    const config = loadApiConfig({
      ...minimal,
      KEYCLOAK_ADMIN_URL: 'https://id.example.test',
      KEYCLOAK_ADMIN_REALM: 'blackwing',
      KEYCLOAK_ORG_ADMIN_CLIENT_ID: 'bw-org-admin',
      KEYCLOAK_ORG_ADMIN_SECRET_PATH: 'secret/data/platform/keycloak/org-admin',
    });
    expect(config.KEYCLOAK_ADMIN_REALM).toBe('blackwing');
    expect(
      refusal({ ...minimal, KEYCLOAK_ADMIN_URL: 'ftp://id.example.test' }).invalidKeys,
    ).toEqual(['KEYCLOAK_ADMIN_URL']);
  });

  it('boots from the repository .env.example on the dev port', () => {
    const env: Record<string, string> = {};
    const text = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match?.[1] !== undefined) env[match[1]] = match[2] ?? '';
    }
    const config = loadApiConfig({ ...env, NODE_ENV: 'test' });
    expect(config.API_PORT).toBe(13_400);
    expect(config.WEB_ORIGIN).toEqual(['http://localhost:3000']);
  });
  describe('global auth settings (#335)', () => {
    it('defaults the audience, leeway and JWKS windows and leaves the issuer and secrets unset', () => {
      const config = loadApiConfig(minimal);
      expect(config.API_JWT_AUDIENCE).toBe('blackwing-api');
      expect(config.API_JWT_LEEWAY_SECONDS).toBe(60);
      expect(config.API_JWKS_TTL_MS).toBe(600_000);
      expect(config.API_JWKS_REFETCH_COOLDOWN_MS).toBe(30_000);
      expect(config.API_JWKS_TIMEOUT_MS).toBe(3000);
      expect(config.KEYCLOAK_ISSUER_URL).toBeUndefined();
      expect(config.BW_WEB_SESSION_SECRET).toBeUndefined();
    });

    it('accepts a leeway from 0 to 300 seconds and refuses anything outside it', () => {
      expect(
        loadApiConfig({ ...minimal, API_JWT_LEEWAY_SECONDS: '0' }).API_JWT_LEEWAY_SECONDS,
      ).toBe(0);
      expect(
        loadApiConfig({ ...minimal, API_JWT_LEEWAY_SECONDS: '300' }).API_JWT_LEEWAY_SECONDS,
      ).toBe(300);
      for (const bad of ['301', '-1', '1.5', 'soon']) {
        expect(refusal({ ...minimal, API_JWT_LEEWAY_SECONDS: bad }).invalidKeys).toContain(
          'API_JWT_LEEWAY_SECONDS',
        );
      }
    });

    it('refuses a Keycloak issuer that is not a URL', () => {
      expect(refusal({ ...minimal, KEYCLOAK_ISSUER_URL: 'not a url' }).invalidKeys).toContain(
        'KEYCLOAK_ISSUER_URL',
      );
    });

    it('refuses a BFF session secret shorter than 32 characters, for either the current or previous key', () => {
      const short = 'x'.repeat(31);
      expect(refusal({ ...minimal, BW_WEB_SESSION_SECRET: short }).invalidKeys).toContain(
        'BW_WEB_SESSION_SECRET',
      );
      expect(refusal({ ...minimal, BW_WEB_SESSION_SECRET_PREVIOUS: short }).invalidKeys).toContain(
        'BW_WEB_SESSION_SECRET_PREVIOUS',
      );
      expect(
        loadApiConfig({ ...minimal, BW_WEB_SESSION_SECRET: 'x'.repeat(32) }).BW_WEB_SESSION_SECRET,
      ).toBe('x'.repeat(32));
    });

    it('treats an empty session secret as unset, as the example file does', () => {
      expect(
        loadApiConfig({ ...minimal, BW_WEB_SESSION_SECRET: '' }).BW_WEB_SESSION_SECRET,
      ).toBeUndefined();
    });
  });
});
