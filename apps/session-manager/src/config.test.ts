import { describe, expect, it } from 'vitest';

import { configHash, loadSessionManagerConfig } from './config.js';
import { SmConfigInvalidError } from './errors.js';

const SECRET_A = 'a'.repeat(48);
const SECRET_B = 'b'.repeat(48);
/** A copy of `env` without `key`, so a test can drop one required variable. */
function without(env: Record<string, string>, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== key));
}

const VALID_ENV = {
  NODE_ENV: 'test',
  SM_RUN_TOKEN_SECRET: SECRET_A,
  SM_CONTROL_TOKEN_SECRET: SECRET_B,
  DATABASE_URL: 'postgres://sm:dbpw@127.0.0.1:5432/bw',
  VALKEY_URL: 'redis://:valkeypw@127.0.0.1:6379/0',
};

describe('loadSessionManagerConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadSessionManagerConfig(VALID_ENV);
    expect(config.SM_MGMT_ADDR).toEqual({ host: '0.0.0.0', port: 7080 });
    expect(config.SM_SESSION_TTL_SECONDS).toBe(1800);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.OPENBAO_ADDR).toBe('http://openbao:8200');
    expect(config.SM_DRAIN_TIMEOUT).toBe(10_000);
  });

  it('reads the listen address, TTL and drain timeout from the environment', () => {
    const config = loadSessionManagerConfig({
      ...VALID_ENV,
      SM_MGMT_ADDR: '127.0.0.1:17080',
      SM_SESSION_TTL_SECONDS: '900',
      SM_DRAIN_TIMEOUT: '5s',
    });
    expect(config.SM_MGMT_ADDR).toEqual({ host: '127.0.0.1', port: 17_080 });
    expect(config.SM_SESSION_TTL_SECONDS).toBe(900);
    expect(config.SM_DRAIN_TIMEOUT).toBe(5000);
  });

  it('fails with the offending key names and no values when a required key is missing', () => {
    let caught: unknown;
    try {
      loadSessionManagerConfig(without(VALID_ENV, 'DATABASE_URL'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SmConfigInvalidError);
    const error = caught as SmConfigInvalidError;
    expect(error.keys).toContain('DATABASE_URL');
    expect(error.code).toBe('SM_CONFIG_INVALID');
    expect(error.message).not.toContain('dbpw');
  });

  it('refuses NODE_ENV that is absent, because no dev default may be guessed', () => {
    expect(() => loadSessionManagerConfig(without(VALID_ENV, 'NODE_ENV'))).toThrow(
      SmConfigInvalidError,
    );
  });

  it.each([
    ['a short run token key', { SM_RUN_TOKEN_SECRET: 'short' }, 'SM_RUN_TOKEN_SECRET'],
    ['a short control token key', { SM_CONTROL_TOKEN_SECRET: 'short' }, 'SM_CONTROL_TOKEN_SECRET'],
    ['a non-postgres database URL', { DATABASE_URL: 'mysql://x' }, 'DATABASE_URL'],
    ['a non-redis Valkey URL', { VALKEY_URL: 'http://x' }, 'VALKEY_URL'],
    ['a malformed listen address', { SM_MGMT_ADDR: 'nope' }, 'SM_MGMT_ADDR'],
    ['a port out of range', { SM_MGMT_ADDR: ':70000' }, 'SM_MGMT_ADDR'],
    ['a zero TTL', { SM_SESSION_TTL_SECONDS: '0' }, 'SM_SESSION_TTL_SECONDS'],
    ['a TTL above the ceiling', { SM_SESSION_TTL_SECONDS: '86401' }, 'SM_SESSION_TTL_SECONDS'],
    ['a zero drain timeout', { SM_DRAIN_TIMEOUT: '0ms' }, 'SM_DRAIN_TIMEOUT'],
    ['a non-HTTP OpenBao address', { OPENBAO_ADDR: 'ftp://bao' }, 'OPENBAO_ADDR'],
  ])('rejects %s', (_label, override, key) => {
    let caught: unknown;
    try {
      loadSessionManagerConfig({ ...VALID_ENV, ...override });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SmConfigInvalidError);
    expect((caught as SmConfigInvalidError).keys).toContain(key);
  });
});

describe('configHash', () => {
  it('is stable for the same configuration', () => {
    expect(configHash(loadSessionManagerConfig(VALID_ENV))).toBe(
      configHash(loadSessionManagerConfig(VALID_ENV)),
    );
  });

  it('changes with a non-secret value and never embeds a secret value', () => {
    const base = configHash(loadSessionManagerConfig(VALID_ENV));
    const changed = configHash(
      loadSessionManagerConfig({ ...VALID_ENV, SM_SESSION_TTL_SECONDS: '60' }),
    );
    const rotated = configHash(
      loadSessionManagerConfig({ ...VALID_ENV, SM_RUN_TOKEN_SECRET: 'c'.repeat(48) }),
    );
    expect(changed).not.toBe(base);
    // Secret keys contribute only whether they are set, so rotating a token key does not change the hash.
    expect(rotated).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
});
