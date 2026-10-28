import { describe, expect, it } from 'vitest';

import { createPgRotationStore } from './rotation-store.js';

import type { Envelope } from './envelope.js';
import type { TenantSql } from './resolve-store.js';

const T = '01900000-0000-7000-8000-000000000001';
const S = '01900000-0000-7000-8000-0000000000c1';
const envelope = {
  v: 1,
  kekKey: `tenant-${T}`,
  kekVersion: 1,
  wrappedDek: 'vault:v1:x',
} as unknown as Envelope;
const row = {
  id: S,
  tenant_id: T,
  purpose: 'asset_login',
  backend: 'openbao',
  status: 'active',
  current_version: 2,
  envelope,
  external_locator: null,
};

interface Call {
  sql: string;
  values: unknown[];
  tenant: string;
}

function fakeDb(respond: (sql: string) => Record<string, unknown>[]) {
  const calls: Call[] = [];
  let tenant = '';
  const tx: TenantSql = {
    query: (sql, values = []) => {
      calls.push({ sql, values, tenant });
      return Promise.resolve({ rows: respond(sql) });
    },
  };
  const store = createPgRotationStore((tenantId, fn) => {
    tenant = tenantId;
    return fn(tx);
  });
  return { store, calls };
}

const commit = {
  secretId: S,
  expectedVersion: 2,
  previous: { version: 2, envelope, externalLocator: null, retiredAt: new Date(5000) },
  next: { version: 3, envelope },
};

describe('pg rotation store', () => {
  it('loads the record inside the tenant context and maps it', async () => {
    const { store, calls } = fakeDb(() => [row]);
    expect(await store.loadForRotation(T, S)).toEqual({
      id: S,
      tenantId: T,
      purpose: 'asset_login',
      backend: 'openbao',
      status: 'active',
      currentVersion: 2,
      envelope,
      externalLocator: null,
    });
    expect(calls[0]).toMatchObject({ values: [S, T], tenant: T });
    expect(calls[0]?.sql).toMatch(/tenant_id = \$2/);
  });

  it('returns null for an unknown or foreign secret', async () => {
    expect(await fakeDb(() => []).store.loadForRotation(T, S)).toBeNull();
  });

  it('commits a rotation with an optimistic version guard, retiring the prior version', async () => {
    const { store, calls } = fakeDb((sql) => (sql.startsWith('UPDATE') ? [{ id: S }] : []));
    expect(await store.commitRotation(T, commit)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.sql).toMatch(/current_version = \$5/);
    expect(calls[0]?.values).toEqual([S, T, envelope, 3, 2]);
    expect(calls[1]?.sql).toMatch(/ON CONFLICT \(secret_id, version\) DO UPDATE SET retired_at/);
    expect(calls[1]?.values).toEqual([T, S, 2, envelope, null, new Date(5000)]);
    expect(calls[2]?.values).toEqual([T, S, 3, envelope]);
    expect(calls.every((c) => c.tenant === T)).toBe(true);
  });

  it('writes nothing when another rotation moved the version first', async () => {
    const { store, calls } = fakeDb(() => []);
    expect(await store.commitRotation(T, commit)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('pages candidates by keyset, scoped to the tenant KEK and to openbao secrets', async () => {
    const { store, calls } = fakeDb(() => [
      { source: 'version', secret_id: S, version: 1, envelope },
    ]);
    const batch = await store.nextRewrapBatch(T, `tenant-${T}`, 2, undefined, 50);
    expect(batch).toEqual([{ source: 'version', secretId: S, version: 1, envelope }]);
    expect(calls[0]?.values).toEqual([T, `tenant-${T}`, 2, null, 0, '', 50]);
    expect(calls[0]?.sql).toMatch(/backend = 'openbao'/);
    expect(calls[0]?.sql).toMatch(/ORDER BY secret_id, version, source/);

    await store.nextRewrapBatch(
      T,
      `tenant-${T}`,
      2,
      { secretId: S, version: 1, source: 'version' },
      50,
    );
    expect(calls[1]?.values).toEqual([T, `tenant-${T}`, 2, S, 1, 'version', 50]);
  });

  it('refuses a candidate envelope of an unexpected shape', async () => {
    const { store } = fakeDb(() => [
      { source: 'current', secret_id: S, version: 1, envelope: 'oops' },
    ]);
    await expect(store.nextRewrapBatch(T, `tenant-${T}`, 2, undefined, 10)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('saves a rewrap guarded by the version it read, in the tenant context', async () => {
    const { store, calls } = fakeDb(() => [{ id: S }]);
    const candidate = { source: 'current' as const, secretId: S, version: 2, envelope };
    expect(await store.saveRewrap(T, candidate, envelope)).toBe(true);
    expect(calls[0]?.sql).toMatch(
      /UPDATE secrets SET envelope = \$4\s+WHERE id = \$1 AND tenant_id = \$2 AND current_version = \$3/,
    );
    expect(calls[0]?.values).toEqual([S, T, 2, envelope]);
    expect(calls[0]?.tenant).toBe(T);
  });

  it('drops a stale rewrap that no longer matches its row', async () => {
    const { store } = fakeDb(() => []);
    const candidate = { source: 'version' as const, secretId: S, version: 1, envelope };
    expect(await store.saveRewrap(T, candidate, envelope)).toBe(false);
  });
});
