import { describe, expect, it } from 'vitest';

import { configHash, loadSandboxControllerConfig } from './config.js';
import { SbxConfigInvalidError } from './errors.js';

const DIGEST = `ghcr.io/tinycrows/bw-sandbox@sha256:${'a'.repeat(64)}`;
const SECRET = 'k'.repeat(48);

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    SBX_IMAGE_DIGEST: DIGEST,
    SBX_RUN_TOKEN_SECRET: SECRET,
    VALKEY_URL: 'redis://:pw@127.0.0.1:16379/0',
    ...overrides,
  };
}

function invalid(overrides: Record<string, string | undefined>): SbxConfigInvalidError {
  try {
    loadSandboxControllerConfig(env(overrides));
  } catch (error) {
    if (error instanceof SbxConfigInvalidError) return error;
    throw error;
  }
  throw new Error('expected the config to be rejected');
}

describe('loadSandboxControllerConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadSandboxControllerConfig(env());
    expect(config.SBX_MGMT_ADDR).toEqual({ host: '0.0.0.0', port: 7070 });
    expect(config.SBX_DRIVER).toBe('kubernetes');
    expect(config.SBX_NAMESPACE).toBe('bw-runs');
    expect(config.SBX_RUNTIME_CLASS).toBe('gvisor');
    expect(config.SBX_TTL_SECONDS).toBe(3600);
    expect(config.SBX_DRAIN_TIMEOUT).toBe(10_000);
    expect(config.SBX_CPU).toBe(1);
    expect(config.SBX_MEM_MIB).toBe(2048);
    expect(config.SBX_PIDS).toBe(512);
    expect(config.SBX_WORKSPACE_MIB).toBe(1024);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.SBX_IMAGE_DIGEST).toBe(DIGEST);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses explicit values', () => {
    const config = loadSandboxControllerConfig(
      env({
        SBX_MGMT_ADDR: '127.0.0.1:13700',
        SBX_DRIVER: 'docker',
        SBX_NAMESPACE: 'bw-dev-runs',
        SBX_RUNTIME_CLASS: 'runc',
        SBX_TTL_SECONDS: '600',
        SBX_DRAIN_TIMEOUT: '2s',
        LOG_LEVEL: 'debug',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:14318',
      }),
    );
    expect(config.SBX_MGMT_ADDR).toEqual({ host: '127.0.0.1', port: 13_700 });
    expect(config.SBX_DRIVER).toBe('docker');
    expect(config.SBX_TTL_SECONDS).toBe(600);
    expect(config.SBX_DRAIN_TIMEOUT).toBe(2000);
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:14318');
  });

  it('accepts a bracketed IPv6 management address', () => {
    expect(loadSandboxControllerConfig(env({ SBX_MGMT_ADDR: '[::1]:7070' })).SBX_MGMT_ADDR).toEqual(
      {
        host: '::1',
        port: 7070,
      },
    );
  });

  it('edge case: a missing SBX_IMAGE_DIGEST is refused with SBX_CONFIG_INVALID', () => {
    const error = invalid({ SBX_IMAGE_DIGEST: undefined });
    expect(error.code).toBe('SBX_CONFIG_INVALID');
    expect(error.keys).toContain('SBX_IMAGE_DIGEST');
    expect(error.message).toContain('SBX_IMAGE_DIGEST');
  });

  it.each([
    [
      'a tag-only image',
      { SBX_IMAGE_DIGEST: 'ghcr.io/tinycrows/bw-sandbox:latest' },
      'SBX_IMAGE_DIGEST',
    ],
    ['a short digest', { SBX_IMAGE_DIGEST: 'ghcr.io/x/y@sha256:abc' }, 'SBX_IMAGE_DIGEST'],
    ['an unknown driver', { SBX_DRIVER: 'podman' }, 'SBX_DRIVER'],
    ['an invalid namespace', { SBX_NAMESPACE: 'Bad_NS' }, 'SBX_NAMESPACE'],
    ['a zero TTL', { SBX_TTL_SECONDS: '0' }, 'SBX_TTL_SECONDS'],
    ['a non-numeric TTL', { SBX_TTL_SECONDS: '1h' }, 'SBX_TTL_SECONDS'],
    ['a zero drain timeout', { SBX_DRAIN_TIMEOUT: '0' }, 'SBX_DRAIN_TIMEOUT'],
    ['an address without a port', { SBX_MGMT_ADDR: '127.0.0.1' }, 'SBX_MGMT_ADDR'],
    ['an out-of-range port', { SBX_MGMT_ADDR: ':70000' }, 'SBX_MGMT_ADDR'],
    ['a short token secret', { SBX_RUN_TOKEN_SECRET: 'short' }, 'SBX_RUN_TOKEN_SECRET'],
    ['a missing token secret', { SBX_RUN_TOKEN_SECRET: undefined }, 'SBX_RUN_TOKEN_SECRET'],
    ['a non-redis Valkey URL', { VALKEY_URL: 'http://127.0.0.1:16379' }, 'VALKEY_URL'],
    ['a missing Valkey URL', { VALKEY_URL: undefined }, 'VALKEY_URL'],
    ['an unknown log level', { LOG_LEVEL: 'loud' }, 'LOG_LEVEL'],
    ['a zero workspace size', { SBX_WORKSPACE_MIB: '0' }, 'SBX_WORKSPACE_MIB'],
    ['a non-numeric memory size', { SBX_MEM_MIB: '2g' }, 'SBX_MEM_MIB'],
    ['a zero pids limit', { SBX_PIDS: '0' }, 'SBX_PIDS'],
    ['a zero CPU limit', { SBX_CPU: '0' }, 'SBX_CPU'],
    ['a CPU above the ceiling', { SBX_CPU: '17' }, 'SBX_CPU'],
  ])('rejects %s', (_label, overrides, key) => {
    expect(invalid(overrides).keys).toContain(key);
  });

  it('never puts secret values in the error message', () => {
    const error = invalid({ SBX_IMAGE_DIGEST: undefined, VALKEY_URL: 'http://:hunter2@x' });
    expect(error.message).not.toContain('hunter2');
    expect(error.message).not.toContain(SECRET);
  });
});

describe('configHash', () => {
  it('is stable for the same config and changes with a non-secret value', () => {
    const a = configHash(loadSandboxControllerConfig(env()));
    expect(configHash(loadSandboxControllerConfig(env()))).toBe(a);
    expect(configHash(loadSandboxControllerConfig(env({ SBX_NAMESPACE: 'other' })))).not.toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ignores secret values (only their presence counts)', () => {
    const a = configHash(loadSandboxControllerConfig(env()));
    const b = configHash(
      loadSandboxControllerConfig(
        env({ SBX_RUN_TOKEN_SECRET: 'z'.repeat(40), VALKEY_URL: 'redis://:other@10.0.0.1:6379/1' }),
      ),
    );
    expect(b).toBe(a);
  });
});
