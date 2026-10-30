// Notification channels (NOTIFY-001): the repository and the table against the real migrations on Postgres 16
// (Testcontainers). Proves tenant isolation (RLS, cross-tenant reads and writes), the CHECK constraints that refuse
// a credential in `config` or a ref into another tenant, the no-DELETE grant, the secret rotation and shred paths,
// the name conflict, and that a change which cannot be audited is rolled back. Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatSecretRef } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import {
  type NotificationChannelAuditEvent,
  NotificationChannelRepository,
  type SealedChannelSecret,
} from './notification-channel.repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const userA = newId();

/** Postgres error code of a rejected promise (23514 check, 23505 unique, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

const envelope = {
  v: 1,
  alg: 'AES-256-GCM',
  kekKey: 'bw-tenant-kek',
  kekVersion: 1,
  wrappedDek: 'vault:v1:wrapped',
  iv: 'iv',
  tag: 'tag',
  ct: 'ciphertext',
  aadHash: 'hash',
};

/** A sealed credential for a new secret record, bound to `tenantId`. */
function sealed(
  tenantId: string,
  type: 'webhook_secret' | 'api_key' = 'webhook_secret',
): SealedChannelSecret {
  const secretId = newId();
  return {
    secretId,
    ref: formatSecretRef({ tenantId, secretId }),
    envelope: { ...envelope },
    type,
    purpose: 'notification_channel',
  };
}

function makeRepo(events: NotificationChannelAuditEvent[] = [], failAudit = false) {
  return new NotificationChannelRepository({
    db: createDatabase(db.appPool),
    audit: (event) => {
      if (failAudit) throw new Error('ledger unavailable');
      events.push(event);
    },
  });
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  for (const [id, slug] of [
    [tenantA, 'notify-a'],
    [tenantB, 'notify-b'],
  ] as const) {
    await db.withTenant(id, (tx) =>
      tx.query(
        `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, $2, $3, 'eu-west-1', 'team')`,
        [id, slug, `Tenant ${slug}`],
      ),
    );
  }
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('notification channel persistence (NOTIFY-001)', () => {
  it('stores the channel and its credential reference, never a credential in config, with an audit event', async () => {
    const events: NotificationChannelAuditEvent[] = [];
    const repo = makeRepo(events);
    const id = newId();
    const secret = sealed(tenantA);
    const row = await repo.create(tenantA, {
      id,
      kind: 'slack',
      name: 'Gate alerts',
      config: { channel: 'appsec-alerts' },
      status: 'active',
      createdBy: userA,
      secret,
    });
    expect(row.secretRef).toBe(secret.ref);
    expect(row.config).toEqual({ channel: 'appsec-alerts' });
    const stored = await db.withTenant(tenantA, (tx) =>
      tx.query<{ config: unknown; secret_ref: string }>(
        'SELECT config, secret_ref FROM notification_channels WHERE id = $1',
        [id],
      ),
    );
    expect(JSON.stringify(stored.rows[0]?.config)).not.toContain('hooks.slack');
    const secretRow = await db.withTenant(tenantA, (tx) =>
      tx.query<{ envelope: unknown; status: string; type: string }>(
        'SELECT envelope, status, type FROM secrets WHERE id = $1',
        [secret.secretId],
      ),
    );
    expect(secretRow.rows[0]).toMatchObject({ status: 'active', type: 'webhook_secret' });
    expect(events).toEqual([
      expect.objectContaining({
        action: 'notification.channel_changed',
        op: 'created',
        channelId: id,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('bw-tenant-kek');
  });

  it('refuses a second channel with the same name in the tenant (CHANNEL_NAME_CONFLICT)', async () => {
    const repo = makeRepo();
    const error = await repo
      .create(tenantA, {
        id: newId(),
        kind: 'email',
        name: 'Gate alerts',
        config: { addresses: ['soc@example.test'] },
        status: 'active',
        createdBy: userA,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('CHANNEL_NAME_CONFLICT');
  });

  it('refuses a rename onto a name in use (CHANNEL_NAME_CONFLICT) and changes nothing', async () => {
    const repo = makeRepo();
    const other = await repo.create(tenantA, {
      id: newId(),
      kind: 'email',
      name: 'SOC mail',
      config: { addresses: ['soc@example.test'] },
      status: 'active',
      createdBy: userA,
    });
    const error = await repo
      .update(tenantA, other.id, () => ({
        name: 'Gate alerts',
        changedFields: ['name'],
        op: 'updated',
        actorId: userA,
      }))
      .catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe('CHANNEL_NAME_CONFLICT');
    expect((await repo.find(tenantA, other.id))?.name).toBe('SOC mail');
  });

  it('rotates the credential to the next version and keeps the superseded ciphertext as a retired version', async () => {
    const events: NotificationChannelAuditEvent[] = [];
    const repo = makeRepo(events);
    const secret = sealed(tenantA);
    const row = await repo.create(tenantA, {
      id: newId(),
      kind: 'pagerduty',
      name: 'Pager',
      config: { region: 'us' },
      status: 'active',
      createdBy: userA,
      secret,
    });
    const next = {
      ...sealed(tenantA),
      secretId: secret.secretId,
      ref: secret.ref,
      envelope: { ...envelope, ct: 'rotated' },
    };
    const { record, changed } = await repo.update(tenantA, row.id, () => ({
      rotateSecret: next,
      changedFields: ['secret'],
      op: 'secret_rotated',
      actorId: userA,
    }));
    expect(changed).toBe(true);
    expect(record.secretRef).toBe(secret.ref);
    const current = await db.withTenant(tenantA, (tx) =>
      tx.query<{ current_version: number; envelope: { ct: string } }>(
        'SELECT current_version, envelope FROM secrets WHERE id = $1',
        [secret.secretId],
      ),
    );
    expect(current.rows[0]).toMatchObject({ current_version: 2, envelope: { ct: 'rotated' } });
    const retired = await db.withTenant(tenantA, (tx) =>
      tx.query<{ version: number; retired_at: Date | null }>(
        'SELECT version, retired_at FROM secret_versions WHERE secret_id = $1',
        [secret.secretId],
      ),
    );
    expect(retired.rows).toEqual([expect.objectContaining({ version: 1 })]);
    expect(retired.rows[0]?.retired_at).toBeInstanceOf(Date);
    expect(events.at(-1)).toMatchObject({ op: 'secret_rotated' });
  });

  it('refuses to enable a channel whose credential was shredded (CHANNEL_SECRET_UNAVAILABLE)', async () => {
    const repo = makeRepo();
    const secret = sealed(tenantA);
    const row = await repo.create(tenantA, {
      id: newId(),
      kind: 'opsgenie',
      name: 'Opsgenie',
      config: { region: 'eu' },
      status: 'active',
      createdBy: userA,
      secret,
    });
    await repo.update(tenantA, row.id, () => ({
      status: 'disabled',
      changedFields: ['status'],
      op: 'disabled',
      actorId: userA,
    }));
    await db.withTenant(tenantA, (tx) =>
      tx.query(`UPDATE secrets SET envelope = NULL, status = 'shredded' WHERE id = $1`, [
        secret.secretId,
      ]),
    );
    const error = await repo
      .update(tenantA, row.id, () => ({
        status: 'active',
        changedFields: ['status'],
        op: 'enabled',
        actorId: userA,
      }))
      .catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe('CHANNEL_SECRET_UNAVAILABLE');
    expect((await repo.find(tenantA, row.id))?.status).toBe('disabled');
  });

  it('rolls the channel and its credential back when the audit hook fails (no unaudited change)', async () => {
    const repo = makeRepo([], true);
    const id = newId();
    const secret = sealed(tenantA);
    await expect(
      repo.create(tenantA, {
        id,
        kind: 'teams',
        name: 'Unaudited',
        config: {},
        status: 'active',
        createdBy: userA,
        secret,
      }),
    ).rejects.toThrow('ledger unavailable');
    expect(await makeRepo().find(tenantA, id)).toBeUndefined();
    const leftover = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT id FROM secrets WHERE id = $1', [secret.secretId]),
    );
    expect(leftover.rowCount).toBe(0);
  });
});

describe('notification channel tenant isolation (RLS and constraints)', () => {
  it('tenant B cannot read, list or update tenant A channel', async () => {
    const repo = makeRepo();
    const row = await repo.create(tenantA, {
      id: newId(),
      kind: 'email',
      name: 'Isolated',
      config: { addresses: ['soc@example.test'] },
      status: 'active',
      createdBy: userA,
    });
    expect(await makeRepo().find(tenantB, row.id)).toBeUndefined();
    expect((await makeRepo().list(tenantB)).some((channel) => channel.id === row.id)).toBe(false);
    const updated = await db.withTenant(tenantB, (tx) =>
      tx.query(`UPDATE notification_channels SET status = 'disabled' WHERE id = $1`, [row.id]),
    );
    expect(updated.rowCount).toBe(0);
    expect((await repo.find(tenantA, row.id))?.status).toBe('active');
  });

  it('tenant B cannot insert a channel under tenant A', async () => {
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO notification_channels (id, tenant_id, kind, name, config, status, created_by)
           VALUES ($1, $2, 'email', 'Forged', '{"addresses":["x@example.test"]}', 'active', $3)`,
          [newId(), tenantA, userA],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('a channel cannot reference another tenant’s credential (secret_ref CHECK)', async () => {
    const foreign = sealed(tenantB);
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO notification_channels (id, tenant_id, kind, name, config, secret_ref, status, created_by)
           VALUES ($1, $2, 'webhook', 'Cross', '{"url":"https://hooks.example.test/in"}', $3, 'active', $4)`,
          [newId(), tenantA, foreign.ref, userA],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('refuses a credential-looking key in config, a ref on email, and no ref on a secret-bearing kind', async () => {
    const insert = (kind: string, config: string, ref: string | null) =>
      pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO notification_channels (id, tenant_id, kind, name, config, secret_ref, status, created_by)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'active', $7)`,
            [newId(), tenantA, kind, `c-${newId()}`, config, ref, userA],
          ),
        ),
      );
    expect(
      await insert(
        'slack',
        '{"token":"abc"}',
        formatSecretRef({ tenantId: tenantA, secretId: newId() }),
      ),
    ).toBe('23514');
    expect(
      await insert(
        'email',
        '{"addresses":["x@example.test"]}',
        formatSecretRef({ tenantId: tenantA, secretId: newId() }),
      ),
    ).toBe('23514');
    expect(await insert('slack', '{"channel":"x"}', null)).toBe('23514');
    expect(await insert('bogus', '{}', null)).toBe('23514');
  });

  it('the runtime role may not delete a channel (disable, never remove)', async () => {
    const repo = makeRepo();
    const row = await repo.create(tenantA, {
      id: newId(),
      kind: 'email',
      name: 'Keep me',
      config: { addresses: ['soc@example.test'] },
      status: 'active',
      createdBy: userA,
    });
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM notification_channels WHERE id = $1', [row.id]),
      ),
    );
    expect(code).toBe('42501');
  });
});
