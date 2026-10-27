// assertTenantScope against a scripted transaction handle (TENANT-002), and the compile-time
// guarantee of TenantScopedDb (type tests). The real-Postgres proof is tenant-scope.int.test.ts.

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { assertTenantScope, type TenantScopedDb } from './tenant-scope.js';
import {
  hashTenant,
  type SystemTx,
  TenantContextMismatchError,
  type TenantTx,
} from './with-tenant.js';

import type { Database } from './client.js';

/** A transaction handle whose `current_setting('app.tenant_id', true)` returns `setting`. */
function fakeTx(setting: unknown): { tx: TenantScopedDb; executed: () => number } {
  const execute = vi.fn(() => Promise.resolve({ rows: [{ tenant_id: setting }] }));
  return {
    tx: { execute } as unknown as TenantScopedDb,
    executed: () => execute.mock.calls.length,
  };
}

const quiet = { warn: vi.fn() };

describe('assertTenantScope', () => {
  it('passes when a context is set and no expectation is given', async () => {
    const { tx, executed } = fakeTx(newId());
    await expect(assertTenantScope(tx, undefined, { logger: quiet })).resolves.toBeUndefined();
    expect(executed()).toBe(1);
  });

  it('passes when the context matches, ignoring UUID case', async () => {
    const id = newId();
    const { tx } = fakeTx(id.toLowerCase());
    await expect(
      assertTenantScope(tx, id.toUpperCase(), { logger: quiet }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['unset (null)', null],
    ['empty string', ''],
    ['not a string', 42],
    ['undefined', undefined],
  ])('throws TenantContextMissingError when the setting is %s', async (_label, setting) => {
    const metrics = { tenantContextMissing: vi.fn() };
    const { tx } = fakeTx(setting);
    const error: unknown = await assertTenantScope(tx, newId(), { metrics, logger: quiet }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TenantContextMissingError);
    expect((error as TenantContextMissingError).code).toBe('TENANT_CONTEXT_MISSING');
    expect(metrics.tenantContextMissing).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the query returns no row at all', async () => {
    const tx = { execute: () => Promise.resolve({ rows: [] }) } as unknown as TenantScopedDb;
    await expect(assertTenantScope(tx, undefined, { logger: quiet })).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });

  it('throws TenantContextMismatchError when the expected tenant differs', async () => {
    const current = newId();
    const expected = newId();
    const warn = vi.fn();
    const { tx } = fakeTx(current);
    const error: unknown = await assertTenantScope(tx, expected, { logger: { warn } }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TenantContextMismatchError);
    expect((error as TenantContextMismatchError).code).toBe('TENANT_CONTEXT_CONFLICT');
    // Neither the error nor the log line names a tenant id; the log carries only the hash.
    expect((error as Error).message).not.toContain(current);
    expect((error as Error).message).not.toContain(expected);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(current);
    expect(JSON.stringify(warn.mock.calls)).toContain(hashTenant(current));
  });

  it('only reads: a single statement and never a set_config', async () => {
    const { tx, executed } = fakeTx(newId());
    await assertTenantScope(tx, undefined, { logger: quiet });
    expect(executed()).toBe(1);
  });
});

describe('TenantScopedDb (type tests)', () => {
  /** A repository function that proves a tenant context at compile time. */
  const listWidgets = (db: TenantScopedDb): number => Object.keys(db).length * 0;

  it('accepts only a handle produced by withTenant', () => {
    expectTypeOf<TenantTx>().toExtend<TenantScopedDb>();

    const raw = {} as Database;
    const system = {} as SystemTx;
    const scoped = {} as TenantTx;

    // @ts-expect-error a raw Database / pool is not a tenant-scoped handle
    listWidgets(raw);
    // @ts-expect-error a withSystem handle carries no tenant context
    listWidgets(system);
    // @ts-expect-error a plain object cannot forge the brand
    listWidgets({ execute: () => undefined });
    expect(listWidgets(scoped)).toBe(0);
  });
});
