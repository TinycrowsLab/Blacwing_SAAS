// The ScheduleManager's Postgres store and tenant gate (SCHED-003, SCHED-006, SCHED-008) against the real migrations
// on Postgres 16 (Testcontainers): reads and writes stay in their tenant, a stale ETag is refused without a write, every
// change lands with its audit event, and a tenant whose status cannot be read is treated as suspended. Run with
// `pnpm test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, type Database } from '@blackwing/db';
import { newId, toPublicId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createPgScheduleStore } from './store-pg.js';
import { createPgTenantStatusGate } from './tenant-gate-pg.js';

import type { ScheduleAudit } from './ports.js';

let postgres: PostgresHandle;
let db: Database;

const tenantA = newId();
const tenantB = newId();
const saA = newId();
const scheduleA = newId();
const scheduleOfB = newId();
const actor = { type: 'user', id: newId() } as const;

const pause: ScheduleAudit = { action: 'schedule.paused', actor };

/** Inserts a tenant row as the tenant itself (its own policy admits the row). */
async function insertTenant(tenantId: string, status: 'active' | 'suspended'): Promise<void> {
  await postgres.withTenant(tenantId, (tx) =>
    tx.query(
      `INSERT INTO tenants (id, slug, name, region, status) VALUES ($1, $2, 'Tenant', 'eu-west-2', $3)`,
      [tenantId, `t-${tenantId}`, status],
    ),
  );
}

/** Inserts a standing authorisation and a schedule row for a tenant, as the runtime role. */
async function insertSchedule(tenantId: string, saId: string, scheduleId: string): Promise<void> {
  await postgres.withTenant(tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO standing_authorisations (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness, default_budgets, test_windows, valid_from, expires_at, requester_id)
       VALUES ($1, $2, $3, $4::uuid[], '{}', 'passive', '{}', '[]', now(), now() + interval '30 days', $5)`,
      [saId, tenantId, toPublicId(saId, 'sa'), [newId()], newId()],
    );
    await tx.query(
      `INSERT INTO schedules (id, tenant_id, public_id, name, asset_ids, sa_id, mode, cron_expr, timezone, created_by)
       VALUES ($1, $2, $3, 'Nightly', $4::uuid[], $5, 'grey', '0 2 * * *', 'Europe/London', $6)`,
      [scheduleId, tenantId, toPublicId(scheduleId, 'sched'), [newId()], saId, actor.id],
    );
  });
}

/** The audit actions recorded against a schedule, in the tenant's chain. */
async function auditActions(tenantId: string, scheduleId: string): Promise<string[]> {
  const result = await postgres.withTenant(tenantId, (tx) =>
    tx.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE target->>'id' = $1 ORDER BY occurred_at, id`,
      [scheduleId],
    ),
  );
  return result.rows.map((row) => row.action);
}

beforeAll(async () => {
  postgres = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  db = createDatabase(postgres.appPool);
  await insertTenant(tenantA, 'active');
  await insertTenant(tenantB, 'suspended');
  await insertSchedule(tenantA, saA, scheduleA);
  await insertSchedule(tenantB, newId(), scheduleOfB);
}, 240_000);

afterAll(async () => {
  await postgres.stop();
});

describe('ScheduleManager Postgres store', () => {
  it('reads only the tenant’s own schedules', async () => {
    const store = createPgScheduleStore(db);

    expect((await store.get(tenantA, scheduleA))?.id).toBe(scheduleA);
    expect(await store.get(tenantA, scheduleOfB)).toBeNull();
    expect((await store.list(tenantA)).map((row) => row.id)).toEqual([scheduleA]);
  });

  it('writes a state change and records its audit event in the same transaction', async () => {
    const store = createPgScheduleStore(db);
    const temporalScheduleId = `sched-${tenantA}-${scheduleA}`;

    const stored = await store.write(
      tenantA,
      scheduleA,
      { enabled: false, temporalScheduleId, nextFireAt: null },
      { audit: pause },
    );

    expect(stored).toMatchObject({ enabled: false, temporalScheduleId, nextFireAt: null });
    expect(await auditActions(tenantA, scheduleA)).toEqual(['schedule.paused']);
  });

  it('refuses a stale ETag with SCHEDULE_CONFLICT and writes nothing', async () => {
    const store = createPgScheduleStore(db);
    const current = await store.get(tenantA, scheduleA);
    if (current === null) throw new Error('setup');

    await expect(
      store.write(
        tenantA,
        scheduleA,
        { enabled: true },
        { expectedUpdatedAt: '2000-01-01T00:00:00.000Z', audit: pause },
      ),
    ).rejects.toMatchObject({ code: 'SCHEDULE_CONFLICT' });

    expect((await store.get(tenantA, scheduleA))?.enabled).toBe(false);
    expect(await auditActions(tenantA, scheduleA)).toEqual(['schedule.paused']);
  });

  it('applies a write that carries the current ETag', async () => {
    const store = createPgScheduleStore(db);
    const current = await store.get(tenantA, scheduleA);
    if (current === null) throw new Error('setup');

    const stored = await store.write(
      tenantA,
      scheduleA,
      { definition: { cronExpr: '0 3 * * *' } },
      { expectedUpdatedAt: current.updatedAt, audit: { action: 'schedule.updated', actor } },
    );

    expect(stored.cronExpr).toBe('0 3 * * *');
    expect(await auditActions(tenantA, scheduleA)).toEqual(['schedule.paused', 'schedule.updated']);
  });

  it('refuses another tenant’s schedule id on write and delete, and leaves the row alone', async () => {
    const store = createPgScheduleStore(db);

    await expect(
      store.write(tenantB, scheduleA, { enabled: false }, { audit: pause }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      store.delete(tenantB, scheduleA, { action: 'schedule.deleted', actor }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect((await store.get(tenantA, scheduleA))?.cronExpr).toBe('0 3 * * *');
  });

  it('refuses to clear a schedule’s assets (never empty)', async () => {
    const store = createPgScheduleStore(db);

    await expect(
      store.write(tenantA, scheduleA, { definition: { assetIds: [] } }, {}),
    ).rejects.toMatchObject({ code: 'SCHEDULE_NO_ASSETS' });
  });

  it('deletes the row and records the delete in the same transaction', async () => {
    const store = createPgScheduleStore(db);
    const doomed = newId();
    await insertSchedule(tenantA, newId(), doomed);

    await store.delete(tenantA, doomed, { action: 'schedule.deleted', actor });

    expect(await store.get(tenantA, doomed)).toBeNull();
    expect(await auditActions(tenantA, doomed)).toEqual(['schedule.deleted']);
  });
});

describe('ScheduleManager tenant gate', () => {
  it('reports an active tenant as runnable and a suspended one as suspended', async () => {
    const gate = createPgTenantStatusGate(db);

    expect(await gate.isSuspended(tenantA)).toBe(false);
    expect(await gate.isSuspended(tenantB)).toBe(true);
  });

  it('fails closed for a tenant it cannot see, so its schedules never resume', async () => {
    const gate = createPgTenantStatusGate(db);

    expect(await gate.isSuspended(newId())).toBe(true);
  });
});
