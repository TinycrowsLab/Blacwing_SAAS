import { describe, expect, it } from 'vitest';

import { isConfigValidationError } from '@blackwing/config';

import { loadGatewayConfig } from './config.js';

const base = { NODE_ENV: 'test', GATEWAY_ANTHROPIC_BASE_URL: 'http://127.0.0.1:13501' };

describe('loadGatewayConfig', () => {
  it('applies the documented defaults', () => {
    expect(loadGatewayConfig(base)).toMatchObject({
      GATEWAY_HOST: '0.0.0.0',
      GATEWAY_PORT: 8081,
      GATEWAY_UPSTREAM_TIMEOUT_MS: 120_000,
      GATEWAY_MAX_BODY_BYTES: 10_485_760,
      GATEWAY_DEFAULT_PROVIDER: 'anthropic',
    });
    expect(loadGatewayConfig(base).GATEWAY_ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('parses overrides', () => {
    expect(
      loadGatewayConfig({
        ...base,
        GATEWAY_PORT: '13500',
        GATEWAY_UPSTREAM_TIMEOUT_MS: '30s',
        GATEWAY_MAX_BODY_BYTES: '1024',
      }),
    ).toMatchObject({
      GATEWAY_PORT: 13_500,
      GATEWAY_UPSTREAM_TIMEOUT_MS: 30_000,
      GATEWAY_MAX_BODY_BYTES: 1024,
    });
  });

  it('requires an explicit upstream base URL (never defaults to a real provider)', () => {
    expect(() => loadGatewayConfig({ NODE_ENV: 'test' })).toThrow();
  });

  it.each([
    ['GATEWAY_PORT', '0'],
    ['GATEWAY_UPSTREAM_TIMEOUT_MS', '0'],
    ['GATEWAY_MAX_BODY_BYTES', '-1'],
    ['GATEWAY_MAX_BODY_BYTES', '1.5'],
    ['GATEWAY_DEFAULT_PROVIDER', 'openai'],
    ['GATEWAY_ANTHROPIC_BASE_URL', 'ftp://x'],
  ])('rejects %s=%s', (key, value) => {
    let caught: unknown;
    try {
      loadGatewayConfig({ ...base, [key]: value });
    } catch (error) {
      caught = error;
    }
    expect(isConfigValidationError(caught)).toBe(true);
  });
});
