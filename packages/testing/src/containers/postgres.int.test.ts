// withPostgres: RLS-ready schema, app role without BYPASSRLS, SET LOCAL app.tenant_id per
// transaction, and the §8.6 cross-tenant pattern (FOUND-012 acceptance criterion 1).

import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { crossTenantDenied } from '../cross-tenant.js';
import { createFactories } from '../factories.js';
import { MigrationError, type PostgresHandle, RLS_ROLES, withPostgres } from './postgres.js';
import { TenantContextError, withTenant } from './tenant.js';
import { surfaceContainerLogsOnFailure } from '../vitest/index.js';

const MIGRATIONS = fileURLToPath(new URL('./__fixtures__/migrations/', import.meta.url));

let db: PostgresHandle | undefined;
const handle = (): PostgresHandle => {
  if (db === undefined) throw new Error('withPostgres did not start');
  return db;
};
const factories = createFactories({ seed: 42 });
const tenantA = factories.makeTenant();
const tenantB = factories.makeTenant();

beforeAll(async () => {
  db = await withPostgres({ migrations: MIGRATIONS });
});
afterAll(async () => {
  await db?.stop();
});
surfaceContainerLogsOnFailure(() => [db]);

async function insertProbe(tenantId: string, body: string): Promise<string> {
  return handle().withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO rls_probe (tenant_id, body) VALUES ($1, $2) RETURNING id',
      [tenantId, body],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('insert returned no id');
    return id;
  });
}

describe('withPostgres boot', () => {
  it('runs Postgres 16 with pgvector and pgcrypto', async () => {
    const { rows } = await handle().ownerPool.query<{ version: string; extname: string[] }>(
      "SELECT current_setting('server_version_num') AS version, array_agg(extname::text ORDER BY extname) AS extname FROM pg_extension",
    );
    expect(rows[0]?.version.startsWith('16')).toBe(true);
    expect(rows[0]?.extname).toEqual(expect.arrayContaining(['pgcrypto', 'vector']));
  });

  it('creates the app role without SUPERUSER or BYPASSRLS (and not a member of the owner role)', async () => {
    const { rows } = await handle().ownerPool.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
      [[RLS_ROLES.app, RLS_ROLES.owner]],
    );
    expect(rows).toEqual([
      { rolname: 'bw_app', rolsuper: false, rolbypassrls: false },
      { rolname: 'bw_owner', rolsuper: false, rolbypassrls: false },
    ]);
    const member = await handle().appPool.query<{ m: boolean }>(
      "SELECT pg_has_role(current_user, 'bw_owner', 'MEMBER') AS m",
    );
    expect(member.rows[0]?.m).toBe(false);
  });

  it('ran the migrations as the owner role, in file-name order', async () => {
    const { rows } = await handle().ownerPool.query<{
      tableowner: string;
      rowsecurity: boolean;
      forced: boolean;
    }>(
      `SELECT t.tableowner, t.rowsecurity, c.relforcerowsecurity AS forced
         FROM pg_tables t JOIN pg_class c ON c.relname = t.tablename
        WHERE t.schemaname = 'public' AND t.tablename = 'rls_probe'`,
    );
    expect(rows).toEqual([{ tableowner: 'bw_owner', rowsecurity: true, forced: true }]);
    // 0002 adds a pgvector column on top of 0001's table.
    const column = await handle().ownerPool.query<{ udt_name: string }>(
      "SELECT udt_name FROM information_schema.columns WHERE table_name = 'rls_probe' AND column_name = 'embedding'",
    );
    expect(column.rows[0]?.udt_name).toBe('vector');
  });

  it('does not let the app role create objects', async () => {
    await expect(handle().appPool.query('CREATE TABLE app_owned (id int)')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('gives each call its own database (safe to share a reused container)', async () => {
    expect(handle().database).toMatch(/^bw_test_[0-9a-f]{12}$/);
    const { rows } = await handle().appPool.query<{ db: string; usr: string }>(
      'SELECT current_database() AS db, current_user AS usr',
    );
    expect(rows[0]).toEqual({ db: handle().database, usr: 'bw_app' });
  });
});

describe('row-level security through withTenant', () => {
  let rowA = '';

  beforeAll(async () => {
    rowA = await insertProbe(tenantA.id, 'tenant A secret');
    await insertProbe(tenantB.id, 'tenant B secret');
  });

  it("tenant B cannot read tenant A's row, and tenant A can (crossTenantDenied)", async () => {
    const result = await crossTenantDenied(
      (tenantId) =>
        handle().withTenant(tenantId, (tx) =>
          tx.query('SELECT id, body FROM rls_probe WHERE id = $1', [rowA]),
        ),
      { ownerTenantId: tenantA.id, otherTenantId: tenantB.id, subject: 'rls_probe row' },
    );
    expect(result.denial).toBe('empty');
    expect(result.ownerResult.rows).toEqual([{ id: rowA, body: 'tenant A secret' }]);
  });

  it('each tenant sees only its own rows in an unfiltered scan', async () => {
    const seen = await handle().withTenant(tenantB.id, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM rls_probe'),
    );
    expect(seen.rows.length).toBeGreaterThan(0);
    expect(seen.rows.every((r) => r.tenant_id === tenantB.id)).toBe(true);
  });

  it('tenant B cannot write a row into tenant A (WITH CHECK)', async () => {
    await expect(
      handle().withTenant(tenantB.id, (tx) =>
        tx.query("INSERT INTO rls_probe (tenant_id, body) VALUES ($1, 'forged')", [tenantA.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it("tenant B cannot update or delete tenant A's row", async () => {
    const updated = await handle().withTenant(tenantB.id, (tx) =>
      tx.query("UPDATE rls_probe SET body = 'pwned' WHERE id = $1", [rowA]),
    );
    const deleted = await handle().withTenant(tenantB.id, (tx) =>
      tx.query('DELETE FROM rls_probe WHERE id = $1', [rowA]),
    );
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
    const still = await handle().withTenant(tenantA.id, (tx) =>
      tx.query<{ body: string }>('SELECT body FROM rls_probe WHERE id = $1', [rowA]),
    );
    expect(still.rows[0]?.body).toBe('tenant A secret');
  });

  it('a query without a tenant context fails closed', async () => {
    // A fresh session has never seen app.tenant_id: the policy expression itself errors.
    const client = new pg.Client(handle().connectionConfig('app'));
    await client.connect();
    try {
      await expect(client.query('SELECT * FROM rls_probe')).rejects.toThrow(
        /unrecognized configuration parameter "app\.tenant_id"/,
      );
    } finally {
      await client.end();
    }
  });

  it('an empty tenant context fails closed too', async () => {
    const client = await handle().appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      await expect(client.query('SELECT * FROM rls_probe')).rejects.toMatchObject({
        code: '22P02',
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('withTenant refuses a missing or malformed tenant id before touching the database', async () => {
    await expect(handle().withTenant('', () => Promise.resolve(1))).rejects.toBeInstanceOf(
      TenantContextError,
    );
    await expect(
      handle().withTenant('not-a-uuid', () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(TenantContextError);
  });

  it('SET LOCAL does not leak to the next transaction on the same connection', async () => {
    const client = await handle().appPool.connect();
    try {
      await withTenant(client, tenantA.id, (tx) => tx.query('SELECT 1'));
      const { rows } = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.tenant_id', true) AS v",
      );
      expect(rows[0]?.v ?? '').toBe('');
      await expect(client.query('SELECT * FROM rls_probe')).rejects.toMatchObject({
        code: '22P02',
      });
    } finally {
      client.release();
    }
  });

  it('rolls back the whole transaction when fn throws', async () => {
    await expect(
      handle().withTenant(tenantA.id, async (tx) => {
        await tx.query("INSERT INTO rls_probe (tenant_id, body) VALUES ($1, 'rolled back')", [
          tenantA.id,
        ]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await handle().withTenant(tenantA.id, (tx) =>
      tx.query("SELECT 1 FROM rls_probe WHERE body = 'rolled back'"),
    );
    expect(rows).toEqual([]);
  });

  it('accepts the public ten_ id as well as the UUID', async () => {
    const { TenantId } = await import('@blackwing/ids');
    const { rows } = await handle().withTenant(TenantId.fromUuid(tenantA.id), (tx) =>
      tx.query<{ v: string }>("SELECT current_setting('app.tenant_id') AS v"),
    );
    expect(rows[0]?.v).toBe(tenantA.id);
  });
});

describe('migration failures', () => {
  it('reports a missing migrations directory and a failing migration runner', async () => {
    await expect(withPostgres({ migrations: '/nonexistent/migrations' })).rejects.toBeInstanceOf(
      MigrationError,
    );
    await expect(
      withPostgres({
        migrations: async (owner) => {
          await owner.query('SELECT definitely_not_a_function()');
        },
      }),
    ).rejects.toMatchObject({ code: '42883' });
  });
});
