import { describe, expect, it } from 'vitest';

import { createPgSecretStore, type TenantSql } from './resolve-store.js';

const T = '01900000-0000-7000-8000-000000000001';
const S = '01900000-0000-7000-8000-0000000000c1';
const envelope = { v: 1, ct: 'x' };
const row = {
  id: S,
  tenant_id: T,
  type: 'password',
  purpose: 'asset_login',
  backend: 'openbao',
  status: 'active',
  current_version: 3,
  envelope,
  external_locator: null,
};

function fakeDb(rows: { secrets?: Record<string, unknown>; version?: Record<string, unknown> }) {
  const calls: { sql: string; values: unknown[]; tenant: string }[] = [];
  let tenant = '';
  const tx: TenantSql = {
    query: (sql, values = []) => {
      calls.push({ sql, values, tenant });
      const found = sql.includes('FROM secret_versions') ? rows.version : rows.secrets;
      return Promise.resolve({ rows: found === undefined ? [] : [found] });
    },
  };
  const store = createPgSecretStore((tenantId, fn) => {
    tenant = tenantId;
    return fn(tx);
  });
  return { store, calls };
}

describe('pg secret store', () => {
  it('reads the current version from the secrets row inside the tenant context', async () => {
    const { store, calls } = fakeDb({ secrets: row });
    expect(await store.load(T, S)).toEqual({
      id: S,
      tenantId: T,
      type: 'password',
      purpose: 'asset_login',
      backend: 'openbao',
      status: 'active',
      version: 3,
      envelope,
      externalLocator: null,
      retiredAt: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ values: [S, T], tenant: T });
    expect(calls[0]?.sql).toMatch(/tenant_id = \$2/);
    expect(await store.load(T, S, 3)).toMatchObject({ version: 3 });
  });

  it('reads a pinned older version from secret_versions, keeping the record status', async () => {
    const old = { envelope: { v: 1, ct: 'old' }, external_locator: null };
    const { store, calls } = fakeDb({ secrets: { ...row, status: 'rotating' }, version: old });
    expect(await store.load(T, S, 2)).toMatchObject({
      version: 2,
      status: 'rotating',
      envelope: old.envelope,
    });
    expect(calls[1]?.values).toEqual([S, T, 2]);
  });

  it('returns null for an unknown secret or version (another tenant looks the same)', async () => {
    expect(await fakeDb({}).store.load(T, S)).toBeNull();
    expect(await fakeDb({ secrets: row }).store.load(T, S, 1)).toBeNull();
  });

  it('keeps an external locator and a missing purpose', async () => {
    const { store } = fakeDb({
      secrets: {
        ...row,
        backend: 'vault',
        envelope: null,
        external_locator: { path: 'kv/x' },
        purpose: null,
        type: null,
      },
    });
    expect(await store.load(T, S)).toMatchObject({
      backend: 'vault',
      envelope: null,
      externalLocator: { path: 'kv/x' },
      purpose: null,
      type: null,
    });
  });

  it('refuses a row of an unexpected shape', async () => {
    const { store } = fakeDb({ secrets: { ...row, id: 5 } });
    await expect(store.load(T, S)).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
