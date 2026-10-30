// Recurring-run schedules and blackout windows (SCHED-001, CONTEXT_PACK §7, §8.6): tenant isolation, the CHECK
// constraints, the tenant-scoped SA reference, the runtime role's privileges and the repository's service checks,
// against the real migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { isAppError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import { createScheduleRepository } from './schedules.repository.js';

import type { ScheduleCreate } from '@blackwing/contracts';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const saA = newId();
const saB = newId();

/** Postgres error code of a rejected promise (23514 check, 23503 foreign key, 23505 unique, 42501 RLS, 42704). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

/** A standing authorisation row for `tenantId` (the minimum the schedule's foreign key needs). */
async function insertStandingAuthorisation(
  tx: pg.PoolClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO standing_authorisations (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness, default_budgets, test_windows, valid_from, expires_at, requester_id)
     VALUES ($1, $2, $3, $4::uuid[], '{}', 'passive', '{}', '[]', now(), now() + interval '30 days', $5)`,
    [id, tenantId, `sa_${id.replaceAll('-', '')}`, [newId()], newId()],
  );
}

/** A schedule row for `tenantId` bound to `saId`, inserted as the app role. Returns its id. */
async function insertSchedule(
  tx: pg.PoolClient,
  tenantId: string,
  saId: string,
  name = `schedule-${newId()}`,
): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO schedules (id, tenant_id, public_id, name, asset_ids, sa_id, mode, cron_expr, timezone, created_by)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6, 'grey', '0 2 * * *', 'Europe/London', $7)`,
    [id, tenantId, `sched_${id.replaceAll('-', '')}`, name, [newId()], saId, newId()],
  );
  return id;
}

const schedules = { a: '', b: '' };
const blackouts = { a: '', b: '' };

const validCreate = (saId: string): ScheduleCreate => ({
  name: 'Nightly passive sweep',
  assetIds: [newId()],
  saId,
  mode: 'grey',
  objective: null,
  cronExpr: '0 2 * * *',
  timezone: 'Europe/London',
  overlapPolicy: 'skip',
  catchUpPolicy: 'skip',
  catchUpWindowMinutes: 60,
  budgets: {},
  enabled: true,
});

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  await db.withTenant(tenantA, async (tx) => {
    await insertStandingAuthorisation(tx, tenantA, saA);
    schedules.a = await insertSchedule(tx, tenantA, saA, 'Tenant A sweep');
    blackouts.a = newId();
    await tx.query(
      `INSERT INTO blackout_windows (id, tenant_id, scope, starts_at, ends_at, created_by)
       VALUES ($1, $2, 'tenant', now(), now() + interval '1 hour', $3)`,
      [blackouts.a, tenantA, newId()],
    );
  });
  await db.withTenant(tenantB, async (tx) => {
    await insertStandingAuthorisation(tx, tenantB, saB);
    schedules.b = await insertSchedule(tx, tenantB, saB, 'Tenant B sweep');
    blackouts.b = newId();
    await tx.query(
      `INSERT INTO blackout_windows (id, tenant_id, scope, asset_ids, starts_at, ends_at, created_by)
       VALUES ($1, $2, 'asset', $3::uuid[], now(), now() + interval '1 hour', $4)`,
      [blackouts.b, tenantB, [newId()], newId()],
    );
  });
});

afterAll(async () => {
  await db.stop();
});

describe('schedules.rls tenant isolation', () => {
  it('tenant A sees only its own schedules and windows', async () => {
    const rows = await db.withTenant(
      tenantA,
      async (tx) => (await tx.query<{ id: string }>('SELECT id FROM schedules')).rows,
    );
    expect(rows).toEqual([{ id: schedules.a }]);
    const windows = await db.withTenant(
      tenantA,
      async (tx) => (await tx.query<{ id: string }>('SELECT id FROM blackout_windows')).rows,
    );
    expect(windows).toEqual([{ id: blackouts.a }]);
  });

  it('tenant A cannot see, change or delete tenant B schedules and windows', async () => {
    await db.withTenant(tenantA, async (tx) => {
      expect(
        (await tx.query('UPDATE schedules SET enabled = false WHERE id = $1', [schedules.b]))
          .rowCount,
      ).toBe(0);
      expect((await tx.query('DELETE FROM schedules WHERE id = $1', [schedules.b])).rowCount).toBe(
        0,
      );
      expect(
        (await tx.query('DELETE FROM blackout_windows WHERE id = $1', [blackouts.b])).rowCount,
      ).toBe(0);
    });
    const remaining = await db.withTenant(
      tenantB,
      async (tx) => (await tx.query<{ enabled: boolean }>('SELECT enabled FROM schedules')).rows,
    );
    expect(remaining).toEqual([{ enabled: true }]);
  });

  it('tenant A cannot write a schedule or window for tenant B', async () => {
    expect(await pgCode(db.withTenant(tenantA, (tx) => insertSchedule(tx, tenantB, saA)))).toBe(
      '42501',
    );
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO blackout_windows (id, tenant_id, scope, starts_at, ends_at, created_by)
             VALUES ($1, $2, 'tenant', now(), now() + interval '1 hour', $3)`,
            [newId(), tenantB, newId()],
          ),
        ),
      ),
    ).toBe('42501');
  });

  it("refuses to bind another tenant's standing authorisation (tenant-scoped foreign key)", async () => {
    // The plain uuid check would pass here because the foreign key check ignores RLS; the composite key does not.
    expect(await pgCode(db.withTenant(tenantA, (tx) => insertSchedule(tx, tenantA, saB)))).toBe(
      '23503',
    );
  });

  it.each(['schedules', 'blackout_windows'])(
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

describe('schedules.rls constraints', () => {
  it('accepts a Unicode name up to 200 characters and rejects 201 or a blank name', async () => {
    const unicode = 'Sicherheits-Scan 夜間スキャン 🔒';
    expect(
      await pgCode(db.withTenant(tenantA, (tx) => insertSchedule(tx, tenantA, saA, unicode))),
    ).toBeUndefined();
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) => insertSchedule(tx, tenantA, saA, 'x'.repeat(201))),
      ),
    ).toBe('23514');
    expect(
      await pgCode(db.withTenant(tenantA, (tx) => insertSchedule(tx, tenantA, saA, '   '))),
    ).toBe('23514');
    const stored = await db.withTenant(
      tenantA,
      async (tx) =>
        (await tx.query<{ name: string }>('SELECT name FROM schedules WHERE name = $1', [unicode]))
          .rows[0]?.name,
    );
    expect(stored).toBe(unicode);
  });

  it('refuses an empty asset list', async () => {
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO schedules (id, tenant_id, public_id, name, asset_ids, sa_id, mode, cron_expr, timezone, created_by)
             VALUES ($1, $2, $3, 'empty', '{}'::uuid[], $4, 'grey', '0 2 * * *', 'UTC', $5)`,
            [newId(), tenantA, `sched_${newId().replaceAll('-', '')}`, saA, newId()],
          ),
        ),
      ),
    ).toBe('23514');
  });

  it.each([
    ['an unknown mode', `mode = 'destructive'`],
    ['an unknown overlap policy', `overlap_policy = 'queue'`],
    ['an unknown catch-up policy', `catch_up_policy = 'replay_all'`],
    ['a negative catch-up window', `catch_up_window_minutes = -1`],
    ['a catch-up window over one week', `catch_up_window_minutes = 10081`],
    ['an empty cron expression', `cron_expr = ''`],
    ['a blank timezone', `timezone = '   '`],
    ['non-object budgets', `budgets = '[1,2]'::jsonb`],
  ])('refuses %s', async (_label, assignment) => {
    expect(
      await pgCode(
        db.withTenant(tenantA, async (tx) => {
          const id = await insertSchedule(tx, tenantA, saA);
          await tx.query(`UPDATE schedules SET ${assignment} WHERE id = $1`, [id]);
        }),
      ),
    ).toBe('23514');
  });

  it('refuses a window that ends at or before its start', async () => {
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO blackout_windows (id, tenant_id, scope, starts_at, ends_at, created_by)
             VALUES ($1, $2, 'tenant', now(), now(), $3)`,
            [newId(), tenantA, newId()],
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('refuses an unknown blackout scope and an asset window with no assets or a tenant window with assets', async () => {
    const insert = (scope: string, assets: string | null) =>
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO blackout_windows (id, tenant_id, scope, asset_ids, starts_at, ends_at, created_by)
           VALUES ($1, $2, $3, $4::uuid[], now(), now() + interval '1 hour', $5)`,
          [newId(), tenantA, scope, assets, newId()],
        ),
      );
    expect(await pgCode(insert('global', null))).toBe('23514');
    expect(await pgCode(insert('asset', null))).toBe('23514');
    expect(await pgCode(insert('asset', '{}'))).toBe('23514');
    expect(await pgCode(insert('tenant', `{${newId()}}`))).toBe('23514');
    expect(await pgCode(insert('asset', `{${newId()}}`))).toBeUndefined();
  });

  it('refuses a blackout reason over 2000 characters', async () => {
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO blackout_windows (id, tenant_id, scope, starts_at, ends_at, reason, created_by)
             VALUES ($1, $2, 'tenant', now(), now() + interval '1 hour', $3, $4)`,
            [newId(), tenantA, 'x'.repeat(2001), newId()],
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a duplicate public id', async () => {
    const publicId = await db.withTenant(
      tenantA,
      async (tx) =>
        (
          await tx.query<{ public_id: string }>('SELECT public_id FROM schedules WHERE id = $1', [
            schedules.a,
          ])
        ).rows[0]?.public_id,
    );
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO schedules (id, tenant_id, public_id, name, asset_ids, sa_id, mode, cron_expr, timezone, created_by)
             VALUES ($1, $2, $3, 'dup', $4::uuid[], $5, 'grey', '0 2 * * *', 'UTC', $6)`,
            [newId(), tenantA, publicId, [newId()], saA, newId()],
          ),
        ),
      ),
    ).toBe('23505');
  });

  it('bumps updated_at on every update (trigger)', async () => {
    const result = await db.withTenant(tenantA, async (tx) => {
      const before = (
        await tx.query<{ updated_at: Date }>('SELECT updated_at FROM schedules WHERE id = $1', [
          schedules.a,
        ])
      ).rows[0]?.updated_at;
      await tx.query('UPDATE schedules SET enabled = false WHERE id = $1', [schedules.a]);
      const after = (
        await tx.query<{ updated_at: Date }>('SELECT updated_at FROM schedules WHERE id = $1', [
          schedules.a,
        ])
      ).rows[0]?.updated_at;
      return { before, after };
    });
    expect(result.before).toBeInstanceOf(Date);
    expect((result.after?.getTime() ?? 0) > (result.before?.getTime() ?? 1)).toBe(true);
  });

  it('gives the runtime role DML only: no TRUNCATE on either table', async () => {
    expect(await pgCode(db.withTenant(tenantA, (tx) => tx.query('TRUNCATE schedules')))).toBe(
      '42501',
    );
    expect(
      await pgCode(db.withTenant(tenantA, (tx) => tx.query('TRUNCATE blackout_windows'))),
    ).toBe('42501');
  });
});

describe('schedules repository service checks', () => {
  const repository = () => createScheduleRepository(createDatabase(db.appPool));

  it('creates a schedule with a sched_ public id, UTC timestamps and the stored fields', async () => {
    const created = await repository().create(tenantA, newId(), {
      ...validCreate(saA),
      name: 'Nachtlauf 夜間',
      budgets: { requests: 500 },
    });
    expect(created.publicId).toMatch(/^sched_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(created.name).toBe('Nachtlauf 夜間');
    expect(created.budgets).toEqual({ requests: 500 });
    expect(created.tenantId).toBe(tenantA);
    expect(created.createdAt).toMatch(/Z$/);
    expect(await repository().find(tenantA, created.id)).toEqual(created);
  });

  it('refuses an empty asset list as SCHEDULE_NO_ASSETS, before any write', async () => {
    const error: unknown = await repository()
      .create(tenantA, newId(), { ...validCreate(saA), assetIds: [] })
      .catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe('SCHEDULE_NO_ASSETS');
    expect(isAppError(error) && error.httpStatus).toBe(422);
  });

  it('refuses an SA of another tenant as NOT_FOUND (indistinguishable from a missing SA)', async () => {
    const error: unknown = await repository()
      .create(tenantA, newId(), validCreate(saB))
      .catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe('NOT_FOUND');
    const missing: unknown = await repository()
      .create(tenantA, newId(), validCreate(newId()))
      .catch((caught: unknown) => caught);
    expect(isAppError(missing) && missing.code).toBe('NOT_FOUND');
  });

  it('refuses a payload that fails the contract with VALIDATION_FAILED', async () => {
    const error: unknown = await repository()
      .create(tenantA, newId(), {
        ...validCreate(saA),
        mode: 'destructive',
      } as unknown as ScheduleCreate)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ZodError);
  });

  it("does not return another tenant's schedule, and fails closed without a tenant", async () => {
    expect(await repository().find(tenantB, schedules.a)).toBeNull();
    expect(await repository().find(tenantA, schedules.b)).toBeNull();
    const direct = await pgCode(
      (async () => {
        const client = await db.appPool.connect();
        try {
          await client.query('SELECT * FROM schedules');
        } finally {
          client.release();
        }
      })(),
    );
    expect(['42704', '22P02']).toContain(direct);
  });
});
