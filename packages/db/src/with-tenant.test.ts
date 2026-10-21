import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError, TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { unwrapQueryError, withTenant } from './with-tenant.js';

import type { Database } from './client.js';

function fakeDb(execute = vi.fn().mockResolvedValue(undefined)) {
  const tx = { execute };
  const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  return { db: { transaction } as unknown as Database, transaction, execute, tx };
}

describe('withTenant', () => {
  it('sets app.tenant_id transaction-locally before running the callback', async () => {
    const { db, execute, tx } = fakeDb();
    const tenant = newId();
    const result = await withTenant(db, tenant, (handle) => {
      expect(execute).toHaveBeenCalledTimes(1);
      expect(handle).toBe(tx);
      return Promise.resolve('done');
    });
    expect(result).toBe('done');
    const statement = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(statement).toContain("set_config('app.tenant_id'");
    expect(statement).toContain(', true)');
    expect(statement).toContain(tenant);
  });

  it.each([undefined, null, '', 'nope', '123', `${newId()}; DROP TABLE x`])(
    'fails closed on tenant id %j without opening a transaction',
    async (tenantId) => {
      const { db, transaction } = fakeDb();
      await expect(
        withTenant(db, tenantId as never, () => Promise.resolve(1)),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('does not run the callback when set_config fails', async () => {
    const { db } = fakeDb(vi.fn().mockRejectedValue(new Error('boom')));
    const fn = vi.fn();
    await expect(withTenant(db, newId(), fn)).rejects.toThrow('boom');
    expect(fn).not.toHaveBeenCalled();
  });

  it('maps RLS violations to AppErrors, looking through wrapped driver errors', async () => {
    const pgError = Object.assign(new Error('new row violates row-level security policy'), {
      code: '42501',
    });
    const { db } = fakeDb();
    const error = await withTenant(db, newId(), () =>
      Promise.reject(new Error('Failed query', { cause: pgError })),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('rethrows unrelated errors unchanged', async () => {
    const failure = new Error('plain');
    const { db } = fakeDb();
    await expect(withTenant(db, newId(), () => Promise.reject(failure))).rejects.toBe(failure);
  });
});

describe('unwrapQueryError', () => {
  it('returns the innermost error that carries a code, or the input', () => {
    const inner = Object.assign(new Error('inner'), { code: '23503' });
    expect(unwrapQueryError(new Error('outer', { cause: inner }))).toBe(inner);
    const plain = new Error('plain');
    expect(unwrapQueryError(plain)).toBe(plain);
    expect(unwrapQueryError(undefined)).toBeUndefined();
  });
});
