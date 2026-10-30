// Organisation profile (ADMIN-001): tenant isolation, fail-closed context, and the name/settings write that
// commits or rolls back with its audit event, against the real migrations on Postgres 16 (Testcontainers).
// Run with `pnpm test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import {
  type OrgSettingsAuditEvent,
  TenantProfileRepository,
} from './tenant-profile.repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const userA = newId();

function makeRepo() {
  const events: OrgSettingsAuditEvent[] = [];
  const repo = new TenantProfileRepository({
    db: createDatabase(db.appPool),
    audit: (event) => {
      events.push(event);
    },
  });
  return { repo, events };
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  for (const [id, slug, name] of [
    [tenantA, 'profile-a', 'Acme Security'],
    [tenantB, 'profile-b', 'Other Co'],
  ] as const) {
    await db.withTenant(id, async (tx) => {
      await tx.query(
        `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, $2, $3, 'eu-west-1', 'team')`,
        [id, slug, name],
      );
    });
  }
  await db.withTenant(tenantA, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, 'sub-profile', 'profile@example.com', 'Ada')`,
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
  it('returns the name, the read-only columns and the settings of the caller tenant', async () => {
    const { repo } = makeRepo();
    const record = await repo.read(tenantA);
    expect(record).toMatchObject({
      name: 'Acme Security',
      slug: 'profile-a',
      region: 'eu-west-1',
      plan: 'team',
      status: 'active',
      settings: {},
    });
    expect(record?.updatedAt).toBeInstanceOf(Date);
  });

  it('hides another tenant row from a tenant context (RLS on the tenants table)', async () => {
    const rows = await db.withTenant(tenantB, (tx) =>
      tx.query('SELECT id FROM tenants WHERE id = $1', [tenantA]),
    );
    expect(rows.rows).toEqual([]);
  });

  it('reads nothing for another tenant id and fails closed with no tenant context', async () => {
    const { repo } = makeRepo();
    expect(await repo.read(tenantB)).toMatchObject({ name: 'Other Co' });
    await expect(repo.read('')).rejects.toBeInstanceOf(TenantContextMissingError);
  });
});

describe('update', () => {
  it('writes the name, the settings and the audit event in one transaction', async () => {
    const { repo, events } = makeRepo();
    const result = await repo.update(tenantA, () => ({
      name: 'Acme Security Ltd',
      settings: { displayTimezone: 'Europe/Berlin', supportContactEmail: 'soc@acme.test' },
      actorId: userA,
      changes: {
        name: { from: 'Acme Security', to: 'Acme Security Ltd' },
        supportContactEmail: { from: null, to: '[REDACTED]' },
      },
    }));
    expect(result.changed).toBe(true);
    expect(result.record.name).toBe('Acme Security Ltd');
    expect(result.record.settings).toEqual({
      displayTimezone: 'Europe/Berlin',
      supportContactEmail: 'soc@acme.test',
    });
    expect(events).toEqual([
      {
        action: 'org.settings.updated',
        tenantId: tenantA,
        actorId: userA,
        changes: {
          name: { from: 'Acme Security', to: 'Acme Security Ltd' },
          supportContactEmail: { from: null, to: '[REDACTED]' },
        },
      },
    ]);
  });

  it('stores a unicode name (RTL, emoji) exactly', async () => {
    const { repo } = makeRepo();
    const name = 'شركة الأمن 🛡️';
    await repo.update(tenantA, () => ({
      name,
      settings: { displayTimezone: 'Europe/Berlin', supportContactEmail: 'soc@acme.test' },
      actorId: userA,
      changes: { name: { from: 'Acme Security Ltd', to: name } },
    }));
    expect((await repo.read(tenantA))?.name).toBe(name);
  });

  it('is a no-op (no write, no audit) when mutate returns undefined', async () => {
    const { repo, events } = makeRepo();
    const result = await repo.update(tenantA, () => undefined);
    expect(result.changed).toBe(false);
    expect(events).toEqual([]);
  });

  it('rolls the name back when mutate throws (for example a stale If-Match)', async () => {
    const { repo, events } = makeRepo();
    const before = (await repo.read(tenantA))?.name;
    await expect(
      repo.update(tenantA, () => {
        throw new Error('etag mismatch');
      }),
    ).rejects.toThrow('etag mismatch');
    expect((await repo.read(tenantA))?.name).toBe(before);
    expect(events).toEqual([]);
  });

  it('rolls the name back when the audit hook fails (no unaudited change)', async () => {
    const repo = new TenantProfileRepository({
      db: createDatabase(db.appPool),
      audit: () => {
        throw new Error('ledger unavailable');
      },
    });
    const before = (await repo.read(tenantA))?.name;
    await expect(
      repo.update(tenantA, () => ({
        name: 'Unaudited rename',
        settings: { displayTimezone: 'Europe/Berlin', supportContactEmail: 'soc@acme.test' },
        actorId: userA,
        changes: { name: { from: before, to: 'Unaudited rename' } },
      })),
    ).rejects.toThrow('ledger unavailable');
    expect((await repo.read(tenantA))?.name).toBe(before);
  });

  it('hides tenant A from a tenant B context: an UPDATE of its name touches no row', async () => {
    const before = (await makeRepo().repo.read(tenantA))?.name;
    const result = await db.withTenant(tenantB, (tx) =>
      tx.query(`UPDATE tenants SET name = 'Hijacked' WHERE id = $1`, [tenantA]),
    );
    expect(result.rowCount).toBe(0);
    expect((await makeRepo().repo.read(tenantA))?.name).toBe(before);
  });
});
