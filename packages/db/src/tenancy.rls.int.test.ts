// Tenancy schema (TENANT-001, CONTEXT_PACK §7, §8.6): tenants, users and memberships under the real
// migrations on Postgres 16 (Testcontainers). Everything runs as bw_app except the catalogue reads.

import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { membershipSchema, tenantSchema, userSchema } from '@blackwing/contracts';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import {
  assertRlsEnabled,
  migrateDatabase,
  migrationNames,
  toTenantIsolationError,
} from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const tenantC = newId();
const userA = newId();
const userB = newId();

/** Postgres error code of a rejected promise (e.g. 23505 unique, 42501 RLS / privilege, 22P02 bad uuid). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

/** Runs a statement in a savepoint so a failure does not abort the surrounding transaction. */
async function codeIn(tx: pg.PoolClient, text: string, values: unknown[] = []) {
  await tx.query('SAVEPOINT probe');
  const code = await pgCode(tx.query(text, values));
  await tx.query('ROLLBACK TO SAVEPOINT probe');
  return code;
}

const insertTenant = (tx: pg.PoolClient, id: string, slug: string) =>
  tx.query(
    `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, $2, $3, 'eu-west-1', 'team')`,
    [id, slug, `Tenant ${slug}`],
  );

const insertUser = (client: pg.Pool | pg.PoolClient, id: string, sub: string, email: string) =>
  client.query(`INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, $2, $3, 'Ada')`, [
    id,
    sub,
    email,
  ]);

const insertMembership = (tx: pg.PoolClient, tenantId: string, userId: string, roles = '{}') =>
  tx.query('INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, $3)', [
    tenantId,
    userId,
    roles,
  ]);

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  // A tenant row is created inside its own tenant context (its policy is keyed on its id).
  for (const [id, slug] of [
    [tenantA, 'tenant-a'],
    [tenantB, 'tenant-b'],
    [tenantC, 'tenant-c'],
  ] as const) {
    await db.withTenant(id, (tx) => insertTenant(tx, id, slug));
  }
  await insertUser(db.appPool, userA, 'sub-a', 'Ada@Example.test');
  await insertUser(db.appPool, userB, 'sub-b', 'bob@example.test');
  await db.withTenant(tenantA, (tx) => insertMembership(tx, tenantA, userA, '{org_admin}'));
  await db.withTenant(tenantB, async (tx) => {
    await insertMembership(tx, tenantB, userB, '{developer}');
    await insertMembership(tx, tenantB, userA, '{auditor}');
  });
}, 180_000);

afterAll(async () => {
  await db.stop();
});

describe('tenancy migration', () => {
  it('is in the migration list and the tables belong to bw_owner', async () => {
    expect(migrationNames().some((name) => name.endsWith('_tenancy'))).toBe(true);
    const { rows } = await db.ownerPool.query<{ relname: string; owner: string }>(
      `SELECT relname, pg_get_userbyid(relowner) AS owner FROM pg_class
        WHERE relname IN ('tenants', 'users', 'memberships') AND relkind = 'r' ORDER BY relname`,
    );
    expect(rows).toEqual(
      ['memberships', 'tenants', 'users'].map((relname) => ({ relname, owner: 'bw_owner' })),
    );
  });

  it('assertRlsEnabled passes for tenants and memberships', async () => {
    await expect(assertRlsEnabled(db.ownerPool, 'tenants')).resolves.toBeUndefined();
    await expect(assertRlsEnabled(db.ownerPool, 'memberships')).resolves.toBeUndefined();
  });

  it('users is global: no RLS, no tenant_id column', async () => {
    const { rows } = await db.ownerPool.query<{ rls: boolean; has_tenant: boolean }>(
      `SELECT c.relrowsecurity AS rls,
              EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'users' AND column_name = 'tenant_id') AS has_tenant
         FROM pg_class c WHERE c.relname = 'users' AND c.relkind = 'r'`,
    );
    expect(rows).toEqual([{ rls: false, has_tenant: false }]);
  });

  it('bw_app is not BYPASSRLS, not superuser and cannot run DDL', async () => {
    const { rows } = await db.ownerPool.query(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'bw_app'",
    );
    expect(rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
    const client = await db.appPool.connect();
    try {
      for (const ddl of [
        'CREATE TABLE bw_app_ddl_probe (id int)',
        'ALTER TABLE memberships DISABLE ROW LEVEL SECURITY',
        'ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY',
        'DROP POLICY memberships_tenant_isolation ON memberships',
        'ALTER TABLE users ADD COLUMN probe int',
        'TRUNCATE memberships',
      ]) {
        expect(await pgCode(client.query(ddl)), ddl).toBe('42501');
      }
    } finally {
      client.release();
    }
  });

  it('grants DML to bw_app and nothing to PUBLIC', async () => {
    const { rows } = await db.ownerPool.query<{
      table_name: string;
      grantee: string;
      privilege_type: string;
    }>(
      `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_name IN ('tenants', 'users', 'memberships') AND grantee IN ('bw_app', 'PUBLIC')`,
    );
    expect(rows.some((r) => r.grantee === 'PUBLIC')).toBe(false);
    for (const table of ['tenants', 'users', 'memberships']) {
      const privileges = rows
        .filter((r) => r.table_name === table)
        .map((r) => r.privilege_type)
        .sort();
      expect(privileges, table).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
  });

  it('has the required indexes, unique keys and foreign keys', async () => {
    const indexes = await db.ownerPool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename IN ('tenants', 'users', 'memberships')",
    );
    const defs = indexes.rows.map((r) => r.indexdef).join('\n');
    expect(defs).toContain('ON public.memberships USING btree (user_id)');
    expect(defs).toContain('UNIQUE INDEX tenants_slug_key ON public.tenants USING btree (slug)');
    expect(defs).toContain('UNIQUE INDEX users_email_key ON public.users USING btree (email)');
    expect(defs).toContain('ON public.memberships USING btree (tenant_id, user_id)');
    const fks = await db.ownerPool.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'memberships'::regclass AND contype = 'f' ORDER BY 1",
    );
    expect(fks.rows.map((r) => r.def)).toEqual([
      'FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
      'FOREIGN KEY (user_id) REFERENCES users(id)',
    ]);
  });
});

describe('fail closed without a tenant context', () => {
  it.each(['tenants', 'memberships'] as const)(
    'SELECT on %s raises, never returns rows',
    async (table) => {
      const client = await db.appPool.connect();
      try {
        // 42704 on a fresh session; 22P02 once a previous transaction on this pooled connection
        // defined and reset the setting to ''. Either way: an error, not zero rows and not all rows.
        const code = await pgCode(client.query(`SELECT * FROM ${table}`));
        expect(['42704', '22P02']).toContain(code);
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
        await client.query('COMMIT');
        expect(await pgCode(client.query(`SELECT * FROM ${table}`))).toBe('22P02');
      } finally {
        client.release();
      }
    },
  );

  it('writes without context raise too, and the error maps to the typed tenant error', async () => {
    const client = await db.appPool.connect();
    try {
      let caught: unknown;
      try {
        await client.query('SELECT * FROM memberships');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(pg.DatabaseError);
      expect(toTenantIsolationError(caught)?.name).toBe('TenantContextMissingError');
      expect(
        await pgCode(
          client.query(
            `INSERT INTO tenants (id, slug, name, region) VALUES ($1, 'no-context', 'x', 'eu-west-1')`,
            [newId()],
          ),
        ),
      ).toMatch(/^(42704|22P02)$/);
    } finally {
      client.release();
    }
  });

  it('an invalid UUID in app.tenant_id is a typed cast error', async () => {
    const client = await db.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', 'not-a-uuid', true)");
      let caught: unknown;
      try {
        await client.query('SELECT * FROM tenants');
      } catch (error) {
        caught = error;
      }
      await client.query('ROLLBACK');
      expect((caught as pg.DatabaseError).code).toBe('22P02');
      expect(toTenantIsolationError(caught)?.name).toBe('TenantContextMissingError');
    } finally {
      client.release();
    }
  });
});

describe('tenant isolation', () => {
  it('a tenant sees only its own tenants row', async () => {
    const rows = await db.withTenant(
      tenantA,
      async (tx) =>
        (await tx.query<{ id: string; slug: string }>('SELECT id, slug FROM tenants')).rows,
    );
    expect(rows).toEqual([{ id: tenantA, slug: 'tenant-a' }]);
  });

  it('a tenant sees only its own memberships, even for a user who belongs to two tenants', async () => {
    const a = await db.withTenant(
      tenantA,
      async (tx) =>
        (
          await tx.query<{ tenant_id: string; user_id: string }>(
            'SELECT tenant_id, user_id FROM memberships',
          )
        ).rows,
    );
    expect(a).toEqual([{ tenant_id: tenantA, user_id: userA }]);
    const b = await db.withTenant(tenantB, async (tx) =>
      (await tx.query<{ user_id: string }>('SELECT user_id FROM memberships')).rows
        .map((r) => r.user_id)
        .sort(),
    );
    expect(b).toEqual([userA, userB].sort());
    const byUser = await db.withTenant(
      tenantA,
      async (tx) =>
        (await tx.query('SELECT 1 FROM memberships WHERE user_id = $1', [userB])).rowCount,
    );
    expect(byUser).toBe(0);
  });

  it('cannot read, update or delete another tenant row (0 rows, no error)', async () => {
    await db.withTenant(tenantA, async (tx) => {
      expect((await tx.query('SELECT 1 FROM tenants WHERE id = $1', [tenantB])).rowCount).toBe(0);
      expect(
        (await tx.query("UPDATE tenants SET name = 'pwned' WHERE id = $1", [tenantB])).rowCount,
      ).toBe(0);
      expect((await tx.query('DELETE FROM tenants WHERE id = $1', [tenantB])).rowCount).toBe(0);
      expect(
        (
          await tx.query("UPDATE memberships SET roles = '{org_admin}' WHERE tenant_id = $1", [
            tenantB,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await tx.query('DELETE FROM memberships WHERE tenant_id = $1', [tenantB])).rowCount,
      ).toBe(0);
    });
    const intact = await db.withTenant(tenantB, async (tx) => ({
      name: (await tx.query<{ name: string }>('SELECT name FROM tenants')).rows[0]?.name,
      memberships: (await tx.query('SELECT 1 FROM memberships')).rowCount,
    }));
    expect(intact).toEqual({ name: 'Tenant tenant-b', memberships: 2 });
  });

  it('WITH CHECK rejects cross-tenant inserts and updates that move a row out', async () => {
    await db.withTenant(tenantA, async (tx) => {
      expect(
        await codeIn(tx, 'INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)', [
          tenantB,
          userB,
        ]),
      ).toBe('42501');
      expect(
        await codeIn(
          tx,
          `INSERT INTO tenants (id, slug, name, region) VALUES ($1, 'sneaky', 'x', 'eu-west-1')`,
          [tenantC],
        ),
      ).toBe('42501');
      expect(
        await codeIn(tx, 'UPDATE memberships SET tenant_id = $1 WHERE tenant_id = $2', [
          tenantB,
          tenantA,
        ]),
      ).toBe('42501');
      expect(await codeIn(tx, 'UPDATE tenants SET id = $1 WHERE id = $2', [newId(), tenantA])).toBe(
        '42501',
      );
    });
  });

  it('a tenant can be created only inside its own context', async () => {
    const fresh = newId();
    await db.withTenant(fresh, async (tx) => {
      await insertTenant(tx, fresh, 'fresh-co');
      expect((await tx.query('SELECT slug FROM tenants')).rows).toEqual([{ slug: 'fresh-co' }]);
    });
    const code = await pgCode(
      db.withTenant(tenantA, (tx) => insertTenant(tx, newId(), 'other-co')),
    );
    expect(code).toBe('42501');
  });

  it('property: random tenant contexts never leak across SET LOCAL boundaries', async () => {
    const ids = [tenantA, tenantB, tenantC];
    const expected = new Map<string, number>([
      [tenantA, 1],
      [tenantB, 2],
      [tenantC, 0],
    ]);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...ids), { minLength: 1, maxLength: 6 }),
        async (sequence) => {
          const client = await db.appPool.connect();
          try {
            for (const id of sequence) {
              await client.query('BEGIN');
              await client.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
              const rows = (
                await client.query<{ tenant_id: string }>('SELECT tenant_id FROM memberships')
              ).rows;
              const tenantRows = (await client.query<{ id: string }>('SELECT id FROM tenants'))
                .rows;
              await client.query('COMMIT');
              expect(rows.every((r) => r.tenant_id === id)).toBe(true);
              expect(rows).toHaveLength(expected.get(id) ?? -1);
              expect(tenantRows).toEqual([{ id }]);
              // The context ended with the transaction: the next statement fails closed.
              expect(['42704', '22P02']).toContain(
                await pgCode(client.query('SELECT 1 FROM memberships')),
              );
            }
          } finally {
            client.release();
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});

describe('constraints', () => {
  it('memberships: composite PK stops duplicates; FKs reject unknown tenants and users', async () => {
    await db.withTenant(tenantA, async (tx) => {
      expect(
        await codeIn(tx, 'INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)', [
          tenantA,
          userA,
        ]),
      ).toBe('23505');
      expect(
        await codeIn(tx, 'INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)', [
          tenantA,
          newId(),
        ]),
      ).toBe('23503');
    });
    const ghost = newId();
    expect(await pgCode(db.withTenant(ghost, (tx) => insertMembership(tx, ghost, userA)))).toBe(
      '23503',
    );
  });

  it('memberships: roles default to an empty array (no permissions) and are not nullable', async () => {
    await db.withTenant(tenantC, async (tx) => {
      await insertMembership(tx, tenantC, userB);
      const { rows } = await tx.query<{ roles: string[] }>('SELECT roles FROM memberships');
      expect(rows).toEqual([{ roles: [] }]);
      expect(await codeIn(tx, 'UPDATE memberships SET roles = NULL')).toBe('23502');
    });
    await db.withTenant(tenantC, (tx) => tx.query('DELETE FROM memberships'));
  });

  it('users: email is case-insensitive unique, keycloak_sub unique, status constrained', async () => {
    expect(await pgCode(insertUser(db.appPool, newId(), 'sub-dup-1', 'ADA@example.TEST'))).toBe(
      '23505',
    );
    expect(
      await pgCode(insertUser(db.appPool, newId(), 'sub-a', 'someone-else@example.test')),
    ).toBe('23505');
    expect(
      await pgCode(
        db.appPool.query(
          `INSERT INTO users (id, keycloak_sub, email, status) VALUES ($1, 'sub-x', 'x@example.test', 'banned')`,
          [newId()],
        ),
      ),
    ).toBe('23514');
    const { rows } = await db.appPool.query(
      "SELECT email FROM users WHERE email = 'ada@EXAMPLE.test'",
    );
    expect(rows).toEqual([{ email: 'Ada@Example.test' }]);
  });

  it('tenants: slug is unique and well-formed, status is constrained, defaults apply', async () => {
    const id = newId();
    await db.withTenant(id, async (tx) => {
      for (const slug of ['Bad Slug', 'ab', 'a--b', '-lead', 'x'.repeat(64)]) {
        expect(
          await codeIn(
            tx,
            `INSERT INTO tenants (id, slug, name, region) VALUES ($1, $2, 'x', 'eu-west-1')`,
            [id, slug],
          ),
          slug,
        ).toBe('23514');
      }
      expect(
        await codeIn(
          tx,
          `INSERT INTO tenants (id, slug, name, region, status) VALUES ($1, 'ok-slug', 'x', 'eu-west-1', 'archived')`,
          [id],
        ),
      ).toBe('23514');
      expect(
        await codeIn(
          tx,
          `INSERT INTO tenants (id, slug, name, region) VALUES ($1, 'tenant-a', 'x', 'eu-west-1')`,
          [id],
        ),
      ).toBe('23505');
      await tx.query(
        `INSERT INTO tenants (id, slug, name, region) VALUES ($1, 'defaults-co', 'D', 'eu-west-1')`,
        [id],
      );
      const { rows } = await tx.query(
        'SELECT status, plan, created_at <= updated_at AS ordered FROM tenants',
      );
      expect(rows).toEqual([{ status: 'active', plan: 'free', ordered: true }]);
    });
  });

  it('updated_at moves forward on update, in the database', async () => {
    await db.withTenant(tenantC, async (tx) => {
      const before = (await tx.query<{ updated_at: Date }>('SELECT updated_at FROM tenants'))
        .rows[0]?.updated_at;
      await tx.query("UPDATE tenants SET plan = 'enterprise'");
      const after = (await tx.query<{ updated_at: Date }>('SELECT updated_at FROM tenants')).rows[0]
        ?.updated_at;
      expect((after?.getTime() ?? 0) > (before?.getTime() ?? 0)).toBe(true);
    });
  });

  it('rows round-trip through the Zod contracts', async () => {
    interface Stamps {
      created_at: Date;
      updated_at: Date;
    }
    const stamps = (row: Stamps) => ({
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
    const tenant = await db.withTenant(
      tenantA,
      async (tx) =>
        (
          await tx.query<
            Stamps & {
              id: string;
              slug: string;
              name: string;
              status: string;
              region: string;
              plan: string;
            }
          >('SELECT * FROM tenants')
        ).rows[0],
    );
    if (!tenant) throw new Error('tenant row missing');
    expect(
      tenantSchema.parse({
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        region: tenant.region,
        plan: tenant.plan,
        ...stamps(tenant),
      }).slug,
    ).toBe('tenant-a');
    const user = (
      await db.appPool.query<
        Stamps & {
          id: string;
          keycloak_sub: string;
          email: string;
          name: string | null;
          status: string;
        }
      >('SELECT * FROM users WHERE id = $1', [userA])
    ).rows[0];
    if (!user) throw new Error('user row missing');
    expect(
      userSchema.parse({
        id: user.id,
        keycloakSub: user.keycloak_sub,
        email: user.email,
        name: user.name,
        status: user.status,
        ...stamps(user),
      }).email,
    ).toBe('Ada@Example.test');
    const membership = await db.withTenant(
      tenantA,
      async (tx) =>
        (
          await tx.query<Stamps & { tenant_id: string; user_id: string; roles: string[] }>(
            'SELECT * FROM memberships',
          )
        ).rows[0],
    );
    if (!membership) throw new Error('membership row missing');
    expect(
      membershipSchema.parse({
        tenantId: membership.tenant_id,
        userId: membership.user_id,
        roles: membership.roles,
        ...stamps(membership),
      }).roles,
    ).toEqual(['org_admin']);
  });
});
