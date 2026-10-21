// Unit tests of the isolation assertions against a fake pool: each must fail when the database
// misbehaves (the real database is exercised by packages/db/src/tenant-isolation.int.test.ts).

import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  expectAllTenantTablesForceRls,
  expectAppRoleCannotBypass,
  expectEveryTenantTableCovered,
  expectFailsClosedWithoutContext,
  expectNoLeakAcrossTransactions,
  expectRlsBlocksCrossTenant,
  TenantIsolationError,
} from './tenant-isolation.js';

type Handler = (sql: string, params?: unknown[]) => unknown;

/** A pool whose pooled clients and pool.query share one scripted handler. */
function fakePool(handler: Handler, role = 'bw_app'): pg.Pool {
  const query = (sql: string, params?: unknown[]): Promise<unknown> => {
    if (sql.includes('current_user AS u')) return Promise.resolve({ rows: [{ u: role }] });
    try {
      const out = handler(sql, params);
      return Promise.resolve(out ?? { rows: [], rowCount: 0 });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const client = { query, release: () => undefined };
  // Pool `options.Client` is how pg lets tests supply the connection class.
  class FakeClient {
    query = query;
    connect = () => Promise.resolve();
    end = () => Promise.resolve();
  }
  return Object.assign(Object.create(pg.Pool.prototype) as pg.Pool, {
    query,
    connect: () => Promise.resolve(client),
    options: { Client: FakeClient },
  });
}

const dbError = (code: string): pg.DatabaseError =>
  Object.assign(new pg.DatabaseError('boom', 0, 'error'), { code });
const A = '01900000-0000-7000-8000-00000000000a';
const B = '01900000-0000-7000-8000-00000000000b';

describe('tenant isolation assertions (fake pool)', () => {
  it('refuse to run as a role other than bw_app', async () => {
    const pool = fakePool(() => undefined, 'bw_owner');
    await expect(expectFailsClosedWithoutContext(pool, 'widgets')).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    await expect(expectAppRoleCannotBypass(pool)).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(expectNoLeakAcrossTransactions(pool, A, B)).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it('reject anything but a plain table name (no SQL injection through the table argument)', async () => {
    await expect(
      expectFailsClosedWithoutContext(
        fakePool(() => undefined),
        'a; DROP TABLE x',
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('fail-closed canary: a query without context that returns rows or zero rows is a failure', async () => {
    await expect(
      expectFailsClosedWithoutContext(
        fakePool(() => ({ rows: [{ count: '0' }] })),
        'widgets',
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      expectFailsClosedWithoutContext(
        fakePool(() => ({ rows: [{ count: '3' }] })),
        'widgets',
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('fail-closed canary passes on a missing-context raise and fails on an unrelated error', async () => {
    const raising = (code: string) =>
      fakePool((sql) => {
        if (/SELECT count|DELETE/.test(sql)) throw dbError(code);
      });
    await expect(
      expectFailsClosedWithoutContext(raising('42704'), 'widgets'),
    ).resolves.toBeUndefined();
    await expect(
      expectFailsClosedWithoutContext(raising('22P02'), 'widgets'),
    ).resolves.toBeUndefined();
    await expect(
      expectFailsClosedWithoutContext(raising('42P01'), 'widgets'),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('app role check fails on BYPASSRLS, superuser, and on successful DDL', async () => {
    await expect(
      expectAppRoleCannotBypass(fakePool(() => ({ rows: [{ bypass: true, sup: false }] }))),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      expectAppRoleCannotBypass(fakePool(() => ({ rows: [{ bypass: false, sup: true }] }))),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      expectAppRoleCannotBypass(fakePool(() => ({ rows: [{ bypass: false, sup: false }] }))),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    const denied = fakePool((sql) => {
      if (sql.includes('rolbypassrls')) return { rows: [{ bypass: false, sup: false }] };
      throw dbError('42501');
    });
    await expect(expectAppRoleCannotBypass(denied)).resolves.toBeUndefined();
  });

  it('RLS meta-test fails on a table without forced RLS or a policy, and on no tables at all', async () => {
    const rows = (policy: object) =>
      fakePool((sql) =>
        sql.includes('relkind')
          ? { rows: [{ t: 'widgets' }] }
          : { rows: [{ t: 'widgets', en: true, forced: true, n: '1', ...policy }] },
      );
    await expect(expectAllTenantTablesForceRls(rows({}))).resolves.toEqual(['widgets']);
    await expect(expectAllTenantTablesForceRls(rows({ forced: false }))).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    await expect(expectAllTenantTablesForceRls(rows({ en: false }))).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    await expect(expectAllTenantTablesForceRls(rows({ n: '0' }))).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    await expect(
      expectAllTenantTablesForceRls(fakePool(() => ({ rows: [] }))),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('coverage meta-test fails on a tenant table without isolation tests', async () => {
    const pool = fakePool(() => ({ rows: [{ t: 'a' }, { t: 'b' }] }));
    await expect(expectEveryTenantTableCovered(pool, ['a', 'b'])).resolves.toEqual(['a', 'b']);
    await expect(expectEveryTenantTableCovered(pool, ['a'])).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it('cross-tenant check fails when the owner cannot read its own row (false negative)', async () => {
    const pool = fakePool(() => ({ rows: [{ n: '0' }], rowCount: 0 }));
    await expect(
      expectRlsBlocksCrossTenant(pool, 'widgets', {
        tenantA: A,
        tenantB: B,
        insertRow: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('cross-tenant check fails when another tenant row is visible', async () => {
    const pool = fakePool(() => ({ rows: [{ n: '2' }], rowCount: 0 }));
    await expect(
      expectRlsBlocksCrossTenant(pool, 'widgets', {
        tenantA: A,
        tenantB: B,
        insertRow: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });
});
