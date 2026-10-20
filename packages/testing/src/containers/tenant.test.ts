// withTenant and the Neo4j guard without a database: statement order, rollback, fail-closed inputs.

import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { TenantId } from '@blackwing/ids';

import { runForTenant } from './neo4j.js';
import { TenantContextError, tenantUuid, withTenant } from './tenant.js';

import type { Driver } from 'neo4j-driver';

const TENANT = '01900000-0000-7000-8000-0000000000aa';

interface FakeClient {
  readonly statements: string[];
  readonly params: unknown[][];
  released: unknown[];
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(error?: unknown): void;
}

function fakeClient(fail: (sql: string) => boolean = () => false): FakeClient {
  const client: FakeClient = {
    statements: [],
    params: [],
    released: [],
    query: (sql, params = []) => {
      client.statements.push(sql);
      client.params.push(params);
      return fail(sql)
        ? Promise.reject(new Error(`failed: ${sql}`))
        : Promise.resolve({ rows: [] });
    },
    release: (error) => {
      client.released.push(error);
    },
  };
  return client;
}

const asPoolClient = (client: FakeClient): pg.PoolClient => client as unknown as pg.PoolClient;

describe('tenantUuid', () => {
  it('accepts a UUIDv7 or a ten_ public id', () => {
    expect(tenantUuid(TENANT)).toBe(TENANT);
    expect(tenantUuid(TenantId.fromUuid(TENANT))).toBe(TENANT);
  });

  it.each([
    undefined,
    null,
    '',
    'not-a-uuid',
    '01900000-0000-4000-8000-0000000000aa',
    'run_00000000000000000000000000',
    42,
  ])('fails closed on %j', (value) => {
    expect(() => tenantUuid(value)).toThrow(TenantContextError);
  });

  it('never echoes the rejected value', () => {
    expect(() => tenantUuid('secret-token-value')).toThrow(/^(?!.*secret-token-value)/);
  });
});

describe('withTenant', () => {
  it('runs BEGIN, SET LOCAL app.tenant_id (bound), fn, COMMIT', async () => {
    const client = fakeClient();
    const result = await withTenant(asPoolClient(client), TENANT, async (tx) => {
      await tx.query('SELECT 1');
      return 'done';
    });
    expect(result).toBe('done');
    expect(client.statements).toEqual([
      'BEGIN',
      "SELECT set_config('app.tenant_id', $1, true)",
      'SELECT 1',
      'COMMIT',
    ]);
    expect(client.params[1]).toEqual([TENANT]);
  });

  it('rolls back and rethrows when fn throws', async () => {
    const client = fakeClient();
    await expect(
      withTenant(asPoolClient(client), TENANT, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(client.statements.at(-1)).toBe('ROLLBACK');
    expect(client.statements).not.toContain('COMMIT');
  });

  it('rejects a missing tenant before issuing any statement', async () => {
    const client = fakeClient();
    await expect(
      withTenant(asPoolClient(client), '', () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(TenantContextError);
    expect(client.statements).toEqual([]);
  });

  it('checks a client out of a pool, releases it, and destroys it if the rollback failed', async () => {
    const pool = new pg.Pool();
    const healthy = fakeClient();
    // pg's callback overload of connect() would otherwise be picked for the spy's type.
    const connectable = pool as unknown as { connect: () => Promise<pg.PoolClient> };
    const connect = vi
      .spyOn(connectable, 'connect')
      .mockImplementation(() => Promise.resolve(asPoolClient(healthy)));
    await withTenant(pool, TENANT, () => Promise.resolve(undefined));
    expect(healthy.released).toEqual([undefined]);

    const broken = fakeClient((sql) => sql === 'ROLLBACK');
    connect.mockImplementation(() => Promise.resolve(asPoolClient(broken)));
    await expect(withTenant(pool, TENANT, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(broken.released[0]).toBeInstanceOf(Error);
    await pool.end();
  });
});

describe('runForTenant (Neo4j tenantId guard)', () => {
  const driver = (): { driver: Driver; executeQuery: ReturnType<typeof vi.fn> } => {
    const executeQuery = vi.fn(() => Promise.resolve({ records: [] }));
    return { driver: { executeQuery } as unknown as Driver, executeQuery };
  };

  it('binds tenantId and runs a scoped query', async () => {
    const { driver: d, executeQuery } = driver();
    await runForTenant(d, TENANT, 'MATCH (n) WHERE n.tenantId = $tenantId RETURN n', { limit: 1 });
    expect(executeQuery).toHaveBeenCalledWith('MATCH (n) WHERE n.tenantId = $tenantId RETURN n', {
      limit: 1,
      tenantId: TENANT,
    });
  });

  it.each([
    ['an unscoped query', TENANT, 'MATCH (n) RETURN n', {}],
    ['a lookalike parameter', TENANT, 'MATCH (n) WHERE n.tenantId = $tenantIdx RETURN n', {}],
    [
      'a caller-supplied tenantId',
      TENANT,
      'MATCH (n) WHERE n.tenantId = $tenantId RETURN n',
      { tenantId: 'other' },
    ],
    ['a missing tenant', '', 'MATCH (n) WHERE n.tenantId = $tenantId RETURN n', {}],
  ] as const)('refuses %s without reaching the server', async (_label, tenant, cypher, params) => {
    const { driver: d, executeQuery } = driver();
    await expect(runForTenant(d, tenant, cypher, params)).rejects.toBeInstanceOf(
      TenantContextError,
    );
    expect(executeQuery).not.toHaveBeenCalled();
  });
});
