// Tenant settings (TENANT-008): tenant isolation, fail-closed context, the JSONB shape CHECK, and the
// audit write that commits or rolls back with the change, against the real migrations on Postgres 16
// (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import {
  type TenantSettingsAuditEvent,
  TenantSettingsRepository,
} from './tenant-settings.repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const userA = newId();

/** Postgres error code of a rejected promise (23514 check_violation, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

function makeRepo() {
  const events: TenantSettingsAuditEvent[] = [];
  const repo = new TenantSettingsRepository({
    db: createDatabase(db.appPool),
    audit: (event) => {
      events.push(event);
    },
  });
  return { repo, events };
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  for (const [id, slug] of [
    [tenantA, 'settings-a'],
    [tenantB, 'settings-b'],
  ] as const) {
    await db.withTenant(id, async (tx) => {
      await tx.query(
        `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, $2, $3, 'eu-west-1', 'team')`,
        [id, slug, `Tenant ${slug}`],
      );
    });
  }
  await db.withTenant(tenantA, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, 'sub-a', 'a@example.com', 'Ada')`,
      [userA],
    );
    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, '{org_admin}')`,
      [tenantA, userA],
    );
  });
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('read', () => {
  it('returns the default empty settings and the region of the caller tenant', async () => {
    const { repo } = makeRepo();
    const record = await repo.read(tenantA);
    expect(record?.settings).toEqual({});
    expect(record?.region).toBe('eu-west-1');
    expect(record?.updatedAt).toBeInstanceOf(Date);
  });

  it('hides another tenant row from a tenant context (RLS on the tenants table)', async () => {
    const rows = await db.withTenant(tenantB, (tx) =>
      tx.query('SELECT id FROM tenants WHERE id = $1', [tenantA]),
    );
    expect(rows.rows).toEqual([]);
  });

  it('fails closed with no tenant context, before any query runs', async () => {
    const { repo } = makeRepo();
    await expect(repo.read('')).rejects.toBeInstanceOf(TenantContextMissingError);
  });
});

describe('update', () => {
  it('writes the settings and the audit event in one transaction, and bumps updated_at', async () => {
    const { repo, events } = makeRepo();
    const before = await repo.read(tenantA);
    const result = await repo.update(tenantA, () => ({
      settings: { displayTimezone: 'Europe/Berlin' },
      actorId: userA,
      changes: { displayTimezone: { from: null, to: 'Europe/Berlin' } },
    }));
    expect(result.changed).toBe(true);
    expect(result.record.settings).toEqual({ displayTimezone: 'Europe/Berlin' });
    expect(result.record.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before?.updatedAt.getTime() ?? 0,
    );
    expect(events).toEqual([
      {
        action: 'tenant.settings_updated',
        tenantId: tenantA,
        actorId: userA,
        changes: { displayTimezone: { from: null, to: 'Europe/Berlin' } },
      },
    ]);
  });

  it('is a no-op (no write, no audit) when mutate returns undefined', async () => {
    const { repo, events } = makeRepo();
    const result = await repo.update(tenantA, () => undefined);
    expect(result.changed).toBe(false);
    expect(events).toEqual([]);
  });

  it('rolls the settings back when mutate throws (for example a stale If-Match)', async () => {
    const { repo, events } = makeRepo();
    await expect(
      repo.update(tenantA, () => {
        throw new Error('precondition failed');
      }),
    ).rejects.toThrow('precondition failed');
    expect((await repo.read(tenantA))?.settings).toEqual({ displayTimezone: 'Europe/Berlin' });
    expect(events).toEqual([]);
  });

  it('rolls the settings back when the audit hook fails (no unaudited change)', async () => {
    const repo = new TenantSettingsRepository({
      db: createDatabase(db.appPool),
      audit: () => {
        throw new Error('ledger unavailable');
      },
    });
    await expect(
      repo.update(tenantA, () => ({
        settings: { weekStartsOn: 1 },
        actorId: userA,
        changes: { weekStartsOn: { from: null, to: 1 } },
      })),
    ).rejects.toThrow('ledger unavailable');
    expect((await repo.read(tenantA))?.settings).toEqual({ displayTimezone: 'Europe/Berlin' });
  });

  it('rejects a non-object settings value at the database (CHECK)', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`UPDATE tenants SET settings = '[]'::jsonb WHERE id = $1`, [tenantA]),
      ),
    );
    expect(code).toBe('23514');
  });
});

describe('rolesOf', () => {
  it('returns the membership roles of the caller tenant and nothing for another tenant', async () => {
    const { repo } = makeRepo();
    expect(await repo.rolesOf(tenantA, userA)).toEqual(['org_admin']);
    expect(await repo.rolesOf(tenantB, userA)).toEqual([]);
  });
});
