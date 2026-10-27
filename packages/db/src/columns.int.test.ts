// columns.int: the base column mixins against Postgres 16 (DB-004, Testcontainers). A sample table
// built from every mixin is turned into DDL by drizzle-kit, migrated, and checked through
// information_schema, the updated_at trigger, state_version, FK/index, soft delete and RLS.

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isUuidV7, newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import {
  activeViewSql,
  fromPublicId,
  idColumn,
  isActive,
  publicId,
  retention,
  softDelete,
  stateVersion,
  tenantIdColumn,
  tenantIdIndex,
  timestamps,
  updatedAtTriggerSql,
  updateWithVersion,
} from './columns.js';
import { migrateDatabase } from './migrate.js';

import type pg from 'pg';

const tenants = pgTable('mixin_tenants', { id: idColumn(), name: text('name').notNull() });
const widgets = pgTable(
  'mixin_widgets',
  {
    id: idColumn(),
    tenantId: tenantIdColumn({ references: () => tenants.id }),
    name: text('name').notNull(),
    ...timestamps(),
    ...stateVersion(),
    ...softDelete(),
    ...retention(),
  },
  (t) => [tenantIdIndex('mixin_widgets', t.tenantId)],
);

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

async function columnsOf(table: string) {
  const { rows } = await db.ownerPool.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, r]));
}

async function insertWidget(client: pg.Pool | pg.PoolClient, tenantId: string, name = 'w') {
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO mixin_widgets (tenant_id, name) VALUES ($1, $2) RETURNING id',
    [tenantId, name],
  );
  const row = rows[0];
  if (!row) throw new Error('insert returned no row');
  return row.id;
}

async function timestampsOf(id: string) {
  const { rows } = await db.ownerPool.query<{ created_at: Date; updated_at: Date }>(
    'SELECT created_at, updated_at FROM mixin_widgets WHERE id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error('row not found');
  return row;
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  const ddl = (
    await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ tenants, widgets }))
  ).join('\n');
  const owner = db.ownerPool;
  await owner.query(ddl);
  await owner.query(updatedAtTriggerSql('mixin_widgets'));
  await owner.query(activeViewSql('mixin_widgets'));
  await owner.query('ALTER TABLE mixin_widgets ENABLE ROW LEVEL SECURITY');
  await owner.query(
    `CREATE POLICY tenant_isolation ON mixin_widgets USING (tenant_id = current_setting('app.tenant_id')::uuid)
     WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)`,
  );
  await owner.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON mixin_widgets, mixin_widgets_active TO bw_app',
  );
  for (const id of [tenantA, tenantB]) {
    await owner.query('INSERT INTO mixin_tenants (id, name) VALUES ($1, $2)', [id, `t-${id}`]);
  }
});

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('sample table from all mixins', () => {
  it('migrates cleanly with the expected columns, types and defaults', async () => {
    const cols = await columnsOf('mixin_widgets');
    expect(Object.keys(cols)).toEqual([
      'id',
      'tenant_id',
      'name',
      'created_at',
      'updated_at',
      'state_version',
      'deleted_at',
      'retention_until',
      'legal_hold',
    ]);
    expect(cols.id).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
    expect(cols.id?.column_default).toContain('gen_random_uuid()');
    expect(cols.tenant_id).toMatchObject({
      data_type: 'uuid',
      is_nullable: 'NO',
      column_default: null,
    });
    for (const name of ['created_at', 'updated_at'] as const) {
      expect(cols[name]).toMatchObject({
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
        column_default: 'now()',
      });
    }
    expect(cols.state_version).toMatchObject({
      data_type: 'integer',
      is_nullable: 'NO',
      column_default: '0',
    });
    expect(cols.deleted_at).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
    });
    expect(cols.retention_until).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
    });
    expect(cols.legal_hold).toMatchObject({
      data_type: 'boolean',
      is_nullable: 'NO',
      column_default: 'false',
    });
  });

  it('has the primary key, the tenants FK and the tenant_id index', async () => {
    const { rows } = await db.ownerPool.query<{ contype: string; def: string }>(
      `SELECT contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'mixin_widgets'::regclass`,
    );
    expect(rows.find((r) => r.contype === 'p')?.def).toBe('PRIMARY KEY (id)');
    expect(rows.find((r) => r.contype === 'f')?.def).toContain('REFERENCES mixin_tenants(id)');
    const idx = await db.ownerPool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'mixin_widgets' AND indexname = 'mixin_widgets_tenant_id_idx'`,
    );
    expect(idx.rows[0]?.indexdef).toContain('(tenant_id)');
  });

  it('rejects a null or unknown tenant_id (NOT NULL + FK)', async () => {
    await expect(
      db.ownerPool.query('INSERT INTO mixin_widgets (name) VALUES ($1)', ['x']),
    ).rejects.toMatchObject({
      code: '23502',
    });
    await expect(insertWidget(db.ownerPool, newId())).rejects.toMatchObject({ code: '23503' });
  });

  it('gives raw SQL inserts an id and defaults, and ORM inserts a UUIDv7', async () => {
    const id = await insertWidget(db.ownerPool, tenantA);
    const { rows } = await db.ownerPool.query('SELECT * FROM mixin_widgets WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({
      state_version: 0,
      legal_hold: false,
      deleted_at: null,
      retention_until: null,
    });
    const orm = drizzle({ client: db.ownerPool });
    // blackwing:allow-raw-tenant-db owner-pool inspection in a test, bypassing RLS on purpose
    const [row] = await orm.insert(widgets).values({ tenantId: tenantA, name: 'orm' }).returning();
    expect(isUuidV7(row?.id)).toBe(true);
  });
});

describe('updated_at trigger', () => {
  it('bumps updated_at on a raw SQL update and leaves created_at alone', async () => {
    const id = await insertWidget(db.ownerPool, tenantA, 'before');
    const before = await timestampsOf(id);
    await db.ownerPool.query('SELECT pg_sleep(0.02)');
    await db.ownerPool.query('UPDATE mixin_widgets SET name = $2 WHERE id = $1', [id, 'after']);
    const after = await timestampsOf(id);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.created_at).toEqual(before.created_at);
  });

  it('never lets a client-supplied older updated_at move the column backwards', async () => {
    const id = await insertWidget(db.ownerPool, tenantA);
    const before = await timestampsOf(id);
    await db.ownerPool.query(
      `UPDATE mixin_widgets SET updated_at = '2001-01-01T00:00:00Z' WHERE id = $1`,
      [id],
    );
    const after = await timestampsOf(id);
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
  });
});

describe('state_version', () => {
  it('increments through the repository helper and detects stale writers', async () => {
    const id = await insertWidget(db.ownerPool, tenantA);
    const orm = drizzle({ client: db.ownerPool });
    const first = await updateWithVersion(orm, widgets, { id, expectedVersion: 0 }, { name: 'v1' });
    expect(first).toMatchObject({ name: 'v1', stateVersion: 1 });
    const second = await updateWithVersion(
      orm,
      widgets,
      { id, expectedVersion: 1 },
      { name: 'v2' },
    );
    expect(second?.stateVersion).toBe(2);
    const stale = await updateWithVersion(
      orm,
      widgets,
      { id, expectedVersion: 1 },
      { name: 'lost' },
    );
    expect(stale).toBeUndefined();
    // blackwing:allow-raw-tenant-db owner-pool inspection in a test, bypassing RLS on purpose
    const [row] = await orm.select().from(widgets).where(eq(widgets.id, id));
    expect(row).toMatchObject({ name: 'v2', stateVersion: 2 });
  });

  it('applies RLS: another tenant cannot update the row', async () => {
    const id = await insertWidget(db.ownerPool, tenantA);
    const result = await db.withTenant(tenantB, (tx) =>
      updateWithVersion(
        drizzle({ client: tx }),
        widgets,
        { id, expectedVersion: 0 },
        { name: 'x' },
      ),
    );
    expect(result).toBeUndefined();
  });

  it('is a 32-bit integer (documented overflow past 2^31 - 1)', async () => {
    const id = await insertWidget(db.ownerPool, tenantA);
    await db.ownerPool.query('UPDATE mixin_widgets SET state_version = 2147483647 WHERE id = $1', [
      id,
    ]);
    await expect(
      db.ownerPool.query(
        'UPDATE mixin_widgets SET state_version = state_version + 1 WHERE id = $1',
        [id],
      ),
    ).rejects.toMatchObject({ code: '22003' });
  });
});

describe('soft delete', () => {
  it('keeps soft-deleted rows out of the active view and of isActive() queries, under RLS', async () => {
    const live = await insertWidget(db.ownerPool, tenantA, 'live');
    const gone = await insertWidget(db.ownerPool, tenantA, 'gone');
    const other = await insertWidget(db.ownerPool, tenantB, 'other-tenant');
    await db.ownerPool.query('UPDATE mixin_widgets SET deleted_at = now() WHERE id = $1', [gone]);

    const viaView = await db.withTenant(tenantA, async (tx) =>
      (await tx.query<{ id: string }>('SELECT id FROM mixin_widgets_active')).rows.map((r) => r.id),
    );
    expect(viaView).toContain(live);
    expect(viaView).not.toContain(gone);
    expect(viaView).not.toContain(other);

    // blackwing:allow-raw-tenant-db test-harness db.withTenant hands a plain pg client, already tenant-bound
    const viaFilter = await db.withTenant(tenantA, (tx) =>
      drizzle({ client: tx }).select({ id: widgets.id }).from(widgets).where(isActive(widgets)),
    );
    const ids = viaFilter.map((r) => r.id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(gone);
  });

  it('fails closed on the view without a tenant context', async () => {
    await expect(db.appPool.query('SELECT * FROM mixin_widgets_active')).rejects.toThrow(
      /app\.tenant_id|uuid/,
    );
  });
});

describe('retention and public ids', () => {
  it('stores retention_until and legal_hold', async () => {
    const id = await insertWidget(db.ownerPool, tenantA);
    const orm = drizzle({ client: db.ownerPool });
    // blackwing:allow-raw-tenant-db owner-pool inspection in a test, bypassing RLS on purpose
    await orm
      .update(widgets)
      .set({ retentionUntil: new Date('2030-01-01T00:00:00.000Z'), legalHold: true })
      .where(eq(widgets.id, id));
    // blackwing:allow-raw-tenant-db owner-pool inspection in a test, bypassing RLS on purpose
    const [row] = await orm.select().from(widgets).where(eq(widgets.id, id));
    expect(row?.retentionUntil?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(row?.legalHold).toBe(true);
  });

  it('round-trips a stored id through its public id', async () => {
    const id = newId();
    await db.ownerPool.query(
      'INSERT INTO mixin_widgets (id, tenant_id, name) VALUES ($1, $2, $3)',
      [id, tenantA, 'pub'],
    );
    const { rows } = await db.ownerPool.query('SELECT 1 FROM mixin_widgets WHERE id = $1', [
      fromPublicId(publicId('run', id), 'run'),
    ]);
    expect(rows).toHaveLength(1);
  });
});
