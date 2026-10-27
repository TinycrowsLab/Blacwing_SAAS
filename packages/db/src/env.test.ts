import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isConfigValidationError, isMarkedSecret } from '@blackwing/config';
import { isAppError } from '@blackwing/errors';

import {
  appDbEnvSchema,
  DB_ROLES,
  DEFAULT_DB_IDLE_TX_TIMEOUT_MS,
  DEFAULT_DB_LOCK_TIMEOUT_MS,
  DEFAULT_DB_SLOW_QUERY_MS,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  loadAppDbConfig,
} from './env.js';
import { loadOwnerDbConfig } from './owner.js';
import { expandEnv } from './seed/env.js';

const base = { NODE_ENV: 'test', PGHOST: 'db.internal', PG_APP_PASSWORD: 'app-pw-0123456789' };

function configError(fn: () => unknown): { code: string; keys: string[]; text: string } {
  try {
    fn();
  } catch (error) {
    if (!isConfigValidationError(error)) throw error;
    expect(isAppError(error)).toBe(true);
    return {
      code: error.code,
      keys: error.issues.map((issue) => issue.key),
      text: JSON.stringify(error) + error.message,
    };
  }
  throw new Error('expected a config error');
}

describe('app database settings', () => {
  it('applies the documented defaults', () => {
    const config = loadAppDbConfig(base);
    expect(config).toMatchObject({
      host: 'db.internal',
      port: 5432,
      database: 'blackwing',
      user: DB_ROLES.app,
      poolMax: 10,
      sslMode: 'disable',
      acquireTimeoutMs: 5_000,
      idleTimeoutMs: 30_000,
    });
    expect(isMarkedSecret(config.password)).toBe(true);
  });

  it('parses explicit values', () => {
    const config = loadAppDbConfig({
      ...base,
      PGPORT: '15432',
      PGDATABASE: 'bw',
      PG_APP_USER: 'svc_api',
      PG_POOL_MAX: '25',
      PG_SSLMODE: 'verify-full',
      PG_ACQUIRE_TIMEOUT: '250ms',
    });
    expect(config).toMatchObject({
      port: 15432,
      database: 'bw',
      user: 'svc_api',
      poolMax: 25,
      sslMode: 'verify-full',
      acquireTimeoutMs: 250,
    });
  });

  it('defaults to verified TLS in staging and production', () => {
    for (const NODE_ENV of ['staging', 'production']) {
      expect(loadAppDbConfig({ ...base, NODE_ENV }).sslMode).toBe('require');
    }
  });

  it('refuses plaintext connections in staging and production', () => {
    const error = configError(() =>
      loadAppDbConfig({ ...base, NODE_ENV: 'production', PG_SSLMODE: 'disable' }),
    );
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.keys).toEqual(['PG_SSLMODE']);
  });

  it('fails fast with CONFIG_INVALID and never defaults a password', () => {
    const missing = configError(() => loadAppDbConfig({ NODE_ENV: 'test', PGHOST: 'h' }));
    expect(missing.code).toBe('CONFIG_INVALID');
    expect(missing.keys).toEqual(['PG_APP_PASSWORD']);
    expect(configError(() => loadAppDbConfig({ ...base, PG_APP_PASSWORD: '' })).keys).toEqual([
      'PG_APP_PASSWORD',
    ]);
  });

  it('rejects invalid values, naming keys but never echoing them', () => {
    const error = configError(() =>
      loadAppDbConfig({
        NODE_ENV: 'nope',
        PGHOST: '  ',
        PGPORT: '99999',
        PG_POOL_MAX: '0',
        PG_SSLMODE: 'prefer',
        PG_APP_PASSWORD: 'leak-me-not-123',
      }),
    );
    expect(error.keys.sort()).toEqual([
      'NODE_ENV',
      'PGHOST',
      'PGPORT',
      'PG_POOL_MAX',
      'PG_SSLMODE',
    ]);
    expect(error.text).not.toContain('leak-me-not-123');
  });

  it('refuses the owner role as the runtime user', () => {
    expect(configError(() => loadAppDbConfig({ ...base, PG_APP_USER: 'bw_owner' })).keys).toEqual([
      'PG_APP_USER',
    ]);
  });

  it('never reads owner credentials in a runtime process', () => {
    const ownerPassword = 'owner-pw-must-not-load-42';
    const config: object = loadAppDbConfig({
      ...base,
      PG_OWNER_USER: 'bw_owner',
      PG_OWNER_PASSWORD: ownerPassword,
    });
    expect(JSON.stringify(config)).not.toContain(ownerPassword);
    expect(isMarkedSecret(ownerPassword)).toBe(false);
    expect(Object.keys(appDbEnvSchema.parse(base))).not.toContain('PG_OWNER_PASSWORD');
  });

  it('accepts the repository .env.example once rendered', () => {
    const example = readFileSync(
      fileURLToPath(new URL('../../../.env.example', import.meta.url)),
      'utf8',
    );
    const env: Record<string, string> = {};
    for (const line of example.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!m?.[1]) continue;
      env[m[1]] = m[2] === '' && m[1].endsWith('_PASSWORD') ? 'dev0123456789abcdef' : (m[2] ?? '');
    }
    const source = expandEnv({ ...env, NODE_ENV: 'development' });
    expect(loadAppDbConfig(source)).toMatchObject({ port: 15432, user: 'bw_app' });
    expect(loadOwnerDbConfig(source)).toMatchObject({ port: 15432, user: 'bw_migrator' });
  });
});

describe('owner database settings', () => {
  const owner = { NODE_ENV: 'test', PGHOST: 'h', PG_OWNER_PASSWORD: 'owner-pw-0123' };

  it('defaults the owner role and requires its password', () => {
    expect(loadOwnerDbConfig(owner).user).toBe(DB_ROLES.owner);
    expect(configError(() => loadOwnerDbConfig({ NODE_ENV: 'test', PGHOST: 'h' })).keys).toEqual([
      'PG_OWNER_PASSWORD',
    ]);
  });

  it('refuses the runtime role as the owner', () => {
    expect(
      configError(() => loadOwnerDbConfig({ ...owner, PG_OWNER_USER: 'bw_app' })).keys,
    ).toEqual(['PG_OWNER_USER']);
  });
});

describe('query guardrail settings (DB-007)', () => {
  it('defaults to 15s statements, 30s idle transactions, 5s lock waits and 500ms slow queries', () => {
    expect(loadAppDbConfig(base).guards).toEqual({
      statementTimeoutMs: DEFAULT_DB_STATEMENT_TIMEOUT_MS,
      idleTxTimeoutMs: DEFAULT_DB_IDLE_TX_TIMEOUT_MS,
      lockTimeoutMs: DEFAULT_DB_LOCK_TIMEOUT_MS,
      slowQueryMs: DEFAULT_DB_SLOW_QUERY_MS,
    });
    expect([
      DEFAULT_DB_STATEMENT_TIMEOUT_MS,
      DEFAULT_DB_IDLE_TX_TIMEOUT_MS,
      DEFAULT_DB_LOCK_TIMEOUT_MS,
      DEFAULT_DB_SLOW_QUERY_MS,
    ]).toEqual([15_000, 30_000, 5_000, 500]);
  });

  it('reads the four DB_* settings from the environment', () => {
    expect(
      loadAppDbConfig({
        ...base,
        DB_STATEMENT_TIMEOUT_MS: '2000',
        DB_IDLE_TX_TIMEOUT_MS: '4000',
        DB_LOCK_TIMEOUT_MS: '250',
        DB_SLOW_QUERY_MS: '0',
      }).guards,
    ).toEqual({
      statementTimeoutMs: 2000,
      idleTxTimeoutMs: 4000,
      lockTimeoutMs: 250,
      slowQueryMs: 0,
    });
  });

  it('refuses zero or negative timeouts (Postgres reads 0 as "no timeout"), naming keys only', () => {
    const error = configError(() =>
      loadAppDbConfig({
        ...base,
        DB_STATEMENT_TIMEOUT_MS: '0',
        DB_IDLE_TX_TIMEOUT_MS: '-5',
        DB_LOCK_TIMEOUT_MS: 'soon',
        DB_SLOW_QUERY_MS: '-1',
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.keys.sort()).toEqual([
      'DB_IDLE_TX_TIMEOUT_MS',
      'DB_LOCK_TIMEOUT_MS',
      'DB_SLOW_QUERY_MS',
      'DB_STATEMENT_TIMEOUT_MS',
    ]);
  });

  it('never gives the owner (migration) settings any guardrail', () => {
    expect(
      loadOwnerDbConfig({ ...base, PG_OWNER_PASSWORD: 'owner-pw-0123456789' }),
    ).not.toHaveProperty('guards');
  });
});
