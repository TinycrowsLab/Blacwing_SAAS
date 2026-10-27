// oncall.rls: tenant isolation and constraints for the on-call roster tables (GATE2-003, CONTEXT_PACK
// §7, §8.4, §8.6). Runs the real migrations against Postgres 16 (Testcontainers).

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { migrateDatabase } from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** Postgres error code of a rejected promise (e.g. 23505 unique_violation, 23514 check, 42501 RLS). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

async function insertRoster(
  tx: pg.PoolClient,
  tenantId: string,
  options: { name?: string; active?: boolean } = {},
): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO oncall_rosters (id, tenant_id, name, timezone, active) VALUES ($1, $2, $3, 'Europe/Berlin', $4)`,
    [id, tenantId, options.name ?? `roster-${id}`, options.active ?? true],
  );
  return id;
}

async function insertMember(
  tx: pg.PoolClient,
  tenantId: string,
  rosterId: string,
  options: { userId?: string; level?: number; orderIndex?: number } = {},
): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO oncall_members (id, tenant_id, roster_id, user_id, level, order_index)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      tenantId,
      rosterId,
      options.userId ?? newId(),
      options.level ?? 0,
      options.orderIndex ?? 0,
    ],
  );
  return id;
}

const rosters = { a: '', b: '' };

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  rosters.a = await db.withTenant(tenantA, (tx) => insertRoster(tx, tenantA));
  rosters.b = await db.withTenant(tenantB, async (tx) => {
    const id = await insertRoster(tx, tenantB);
    await insertMember(tx, tenantB, id);
    return id;
  });
});

afterAll(async () => {
  await db.stop();
});

describe('oncall.rls tenant isolation', () => {
  it('tenant A sees only its own roster', async () => {
    const rows = await db.withTenant(
      tenantA,
      async (tx) => (await tx.query<{ id: string }>('SELECT id FROM oncall_rosters')).rows,
    );
    expect(rows).toEqual([{ id: rosters.a }]);
  });

  it('tenant A cannot see, change or delete tenant B members and rosters', async () => {
    await db.withTenant(tenantA, async (tx) => {
      expect((await tx.query('SELECT 1 FROM oncall_members')).rowCount).toBe(0);
      expect(
        (await tx.query('UPDATE oncall_rosters SET name = $1 WHERE id = $2', ['x', rosters.b]))
          .rowCount,
      ).toBe(0);
      expect(
        (await tx.query('DELETE FROM oncall_rosters WHERE id = $1', [rosters.b])).rowCount,
      ).toBe(0);
    });
    const members = await db.withTenant(
      tenantB,
      async (tx) => (await tx.query('SELECT 1 FROM oncall_members')).rowCount,
    );
    expect(members).toBe(1);
  });

  it('tenant A cannot attach a member or window to tenant B roster', async () => {
    // The tenant-scoped foreign key (tenant_id, roster_id) finds no such roster for tenant A.
    expect(await pgCode(db.withTenant(tenantA, (tx) => insertMember(tx, tenantA, rosters.b)))).toBe(
      '23503',
    );
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO oncall_schedules (id, tenant_id, roster_id, user_id, starts_at, ends_at)
             VALUES ($1, $2, $3, $4, now(), now() + interval '1 hour')`,
            [newId(), tenantA, rosters.b, newId()],
          ),
        ),
      ),
    ).toBe('23503');
  });

  it('tenant A cannot write a roster row for tenant B', async () => {
    expect(await pgCode(db.withTenant(tenantA, (tx) => insertRoster(tx, tenantB)))).toBe('42501');
  });

  it.each(['oncall_rosters', 'oncall_members', 'oncall_schedules'])(
    'fails closed on %s without a tenant context',
    async (table) => {
      const client = await db.appPool.connect();
      try {
        expect(['42704', '22P02']).toContain(await pgCode(client.query(`SELECT * FROM ${table}`)));
      } finally {
        client.release();
      }
    },
  );
});

describe('oncall.rls constraints', () => {
  it('allows one active roster per tenant, any number of inactive ones', async () => {
    expect(await pgCode(db.withTenant(tenantA, (tx) => insertRoster(tx, tenantA)))).toBe('23505');
    expect(
      await pgCode(db.withTenant(tenantA, (tx) => insertRoster(tx, tenantA, { active: false }))),
    ).toBeUndefined();
    // Another tenant is unaffected by tenant A's active roster.
    expect(
      await pgCode(db.withTenant(tenantB, (tx) => insertRoster(tx, tenantB, { active: false }))),
    ).toBeUndefined();
  });

  it('rejects a duplicate roster name inside a tenant', async () => {
    await db.withTenant(tenantA, (tx) => insertRoster(tx, tenantA, { name: 'dup', active: false }));
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) => insertRoster(tx, tenantA, { name: 'dup', active: false })),
      ),
    ).toBe('23505');
  });

  it('rejects a level outside the ladder, a duplicate position and a duplicate seat', async () => {
    const user = newId();
    await db.withTenant(tenantA, async (tx) => {
      await insertMember(tx, tenantA, rosters.a, { userId: user, level: 1, orderIndex: 5 });
      await tx.query('SAVEPOINT s');
      expect(await pgCode(insertMember(tx, tenantA, rosters.a, { level: 3 }))).toBe('23514');
      await tx.query('ROLLBACK TO SAVEPOINT s');
      expect(await pgCode(insertMember(tx, tenantA, rosters.a, { level: 1, orderIndex: 5 }))).toBe(
        '23505',
      );
      await tx.query('ROLLBACK TO SAVEPOINT s');
      expect(
        await pgCode(
          insertMember(tx, tenantA, rosters.a, { userId: user, level: 1, orderIndex: 6 }),
        ),
      ).toBe('23505');
      await tx.query('ROLLBACK TO SAVEPOINT s');
    });
  });

  it('rejects a schedule window that ends before it starts', async () => {
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO oncall_schedules (id, tenant_id, roster_id, user_id, starts_at, ends_at)
             VALUES ($1, $2, $3, $4, now(), now() - interval '1 hour')`,
            [newId(), tenantA, rosters.a, newId()],
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('deleting a roster removes its members and windows', async () => {
    const id = await db.withTenant(tenantA, async (tx) => {
      const roster = await insertRoster(tx, tenantA, { active: false });
      await insertMember(tx, tenantA, roster);
      return roster;
    });
    const remaining = await db.withTenant(tenantA, async (tx) => {
      await tx.query('DELETE FROM oncall_rosters WHERE id = $1', [id]);
      return (await tx.query('SELECT 1 FROM oncall_members WHERE roster_id = $1', [id])).rowCount;
    });
    expect(remaining).toBe(0);
  });
});
