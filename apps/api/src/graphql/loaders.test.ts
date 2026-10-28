import { describe, expect, it } from 'vitest';

import { createLoader, createRequestLoaders, createTenantLoader } from './loaders.js';

import type { MemberReadStore, UserRow } from './store.js';

const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';

describe('createLoader', () => {
  it('batches every key requested in one tick into one batch call', async () => {
    const calls: number[][] = [];
    const loader = createLoader<number, number>((keys) => {
      calls.push([...keys]);
      return Promise.resolve(keys.map((key) => key * 10));
    });
    const values = await Promise.all([loader.load(1), loader.load(2), loader.load(3)]);
    expect(values).toEqual([10, 20, 30]);
    expect(calls).toEqual([[1, 2, 3]]);
  });

  it('rejects only the key whose result is an error (partial failure)', async () => {
    const loader = createLoader<number, number>((keys) =>
      Promise.resolve(keys.map((key) => (key === 2 ? new Error('boom') : key))),
    );
    const [one, two] = await Promise.allSettled([loader.load(1), loader.load(2)]);
    expect(one).toEqual({ status: 'fulfilled', value: 1 });
    expect(two).toMatchObject({ status: 'rejected' });
  });

  it('fails every key when the batch returns the wrong number of results', async () => {
    const loader = createLoader<number, number>(() => Promise.resolve([1]));
    const results = await Promise.allSettled([loader.load(1), loader.load(2)]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
  });
});

describe('createTenantLoader', () => {
  it('keeps keys of different tenants in separate batches, so ids never cross tenants', async () => {
    const batches: { tenantId: string; ids: string[] }[] = [];
    const loader = createTenantLoader<string>((tenantId, ids) => {
      batches.push({ tenantId, ids: [...ids] });
      return Promise.resolve(ids.map((id) => `${tenantId}:${id}`));
    });
    const [a1, a2, b1] = await Promise.all([
      loader.load({ tenantId: TENANT_A, id: 'usr_1' }),
      loader.load({ tenantId: TENANT_A, id: 'usr_2' }),
      loader.load({ tenantId: TENANT_B, id: 'usr_1' }),
    ]);
    expect(batches).toEqual([
      { tenantId: TENANT_A, ids: ['usr_1', 'usr_2'] },
      { tenantId: TENANT_B, ids: ['usr_1'] },
    ]);
    expect([a1, a2, b1]).toEqual([`${TENANT_A}:usr_1`, `${TENANT_A}:usr_2`, `${TENANT_B}:usr_1`]);
  });

  it('caches by tenant: the same id under another tenant is a fresh lookup', async () => {
    const seen: string[] = [];
    const loader = createTenantLoader<string>((tenantId, ids) => {
      seen.push(tenantId);
      return Promise.resolve(ids.map(() => undefined));
    });
    await loader.load({ tenantId: TENANT_A, id: 'usr_1' });
    await loader.load({ tenantId: TENANT_B, id: 'usr_1' });
    await loader.load({ tenantId: TENANT_A, id: 'usr_1' });
    expect(seen).toEqual([TENANT_A, TENANT_B]);
  });

  it('fails only the keys of a tenant whose batch throws', async () => {
    const loader = createTenantLoader<string>((tenantId, ids) => {
      if (tenantId === TENANT_B) return Promise.reject(new Error('lookup failed'));
      return Promise.resolve(ids.map((id) => id));
    });
    const results = await Promise.allSettled([
      loader.load({ tenantId: TENANT_A, id: 'usr_1' }),
      loader.load({ tenantId: TENANT_B, id: 'usr_1' }),
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'usr_1' });
    expect(results[1]).toMatchObject({ status: 'rejected' });
  });
});

describe('createRequestLoaders', () => {
  it('resolves nested user lookups in one store call and returns undefined for non-members', async () => {
    const calls: { tenantId: string; ids: readonly string[] }[] = [];
    const user: UserRow = { id: 'usr_1', name: 'Ada', email: 'ada@acme.test' };
    const store: MemberReadStore = {
      listMembers: () => Promise.resolve([]),
      findUsers: (tenantId, ids) => {
        calls.push({ tenantId, ids });
        return Promise.resolve(new Map(ids.includes('usr_1') ? [['usr_1', user]] : []));
      },
    };
    const loaders = createRequestLoaders(store);
    const [found, missing] = await Promise.all([
      loaders.users.load({ tenantId: TENANT_A, id: 'usr_1' }),
      loaders.users.load({ tenantId: TENANT_A, id: 'usr_9' }),
    ]);
    expect(found).toEqual(user);
    expect(missing).toBeUndefined();
    expect(calls).toEqual([{ tenantId: TENANT_A, ids: ['usr_1', 'usr_9'] }]);
  });
});
