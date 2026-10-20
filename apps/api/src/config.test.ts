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
    ['WEB_ORIGIN', 'http://localhost:3000/app'],
    ['WEB_ORIGIN', 'http://localhost:3000/'],
    ['WEB_ORIGIN', 'ftp://localhost'],
    ['NODE_ENV', 'qa'],
  ])('refuses an invalid %s (%s) without echoing the value', (key, value) => {
    const error = refusal({ ...minimal, [key]: value });
    expect(error.invalidKeys.map((invalid) => invalid.replace(/\[\d+\]$/, ''))).toEqual([key]);
    expect(error.message).not.toContain(value);
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
});
