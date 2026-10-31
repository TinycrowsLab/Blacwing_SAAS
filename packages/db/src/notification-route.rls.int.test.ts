// Notification routing rules (NOTIFY-011): the repository and the table against the real migrations on Postgres 16
// (Testcontainers). Proves tenant isolation (RLS: cross-tenant reads, changes and deletes see nothing), the composite
// foreign key that refuses a rule naming another tenant's channel, the CHECK constraints, the enabled-rule lookup that
// blocks a channel delete, and that a change which cannot be audited is rolled back. Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import { NotificationChannelRepository } from './notification-channel.repository.js';
import {
  type NewRouteWrite,
  type NotificationRouteAuditEvent,
  NotificationRouteRepository,
} from './notification-route.repository.js';
import { unwrapQueryError } from './query-errors.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const userA = newId();

/** Postgres error code of a rejected promise (23514 check, 23503 foreign key). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const cause = unwrapQueryError(error);
    return cause instanceof pg.DatabaseError ? cause.code : 'not-a-database-error';
  }
  return undefined;
}

function makeRouteRepo(events: NotificationRouteAuditEvent[] = [], failAudit = false) {
  return new NotificationRouteRepository({
    db: createDatabase(db.appPool),
    audit: (event) => {
      if (failAudit) throw new Error('ledger unavailable');
      events.push(event);
    },
  });
}

function makeChannelRepo() {
  return new NotificationChannelRepository({
    db: createDatabase(db.appPool),
    audit: () => undefined,
  });
}

/** A channel of `tenantId` to point rules at. */
async function channelOf(tenantId: string): Promise<string> {
  const id = newId();
  await makeChannelRepo().create(tenantId, {
    id,
    kind: 'email',
    name: `channel ${id.slice(-6)}`,
    config: { addresses: ['soc@example.test'] },
    status: 'active',
    createdBy: userA,
  });
  return id;
}

function write(channelId: string, overrides: Partial<NewRouteWrite> = {}): NewRouteWrite {
  return {
    id: newId(),
    event: 'kill.fired',
    assetId: null,
    severityMin: 'critical',
    channelId,
    recipientSpec: { onCallGroup: 'soc-primary' },
    enabled: true,
    priority: 10,
    createdBy: userA,
    ...overrides,
  };
}

let channelA: string;
let channelB: string;

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  for (const [id, slug] of [
    [tenantA, 'routes-a'],
    [tenantB, 'routes-b'],
  ] as const) {
    await db.withTenant(id, (tx) =>
      tx.query(
        `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, $2, $3, 'eu-west-1', 'team')`,
        [id, slug, `Tenant ${slug}`],
      ),
    );
  }
  channelA = await channelOf(tenantA);
  channelB = await channelOf(tenantB);
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('notification routing rules (NOTIFY-011)', () => {
  it('stores a rule for its own tenant’s channel, and lists it only there', async () => {
    const events: NotificationRouteAuditEvent[] = [];
    const repo = makeRouteRepo(events);
    const row = await repo.create(tenantA, write(channelA));
    expect(row).toMatchObject({
      tenantId: tenantA,
      channelId: channelA,
      event: 'kill.fired',
      severityMin: 'critical',
    });
    expect(await repo.list(tenantA)).toEqual([expect.objectContaining({ id: row.id })]);
    expect(await repo.list(tenantB)).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'notification.route_changed',
        op: 'created',
        routeId: row.id,
        tenantId: tenantA,
      }),
    ]);
  });

  it('keeps every other tenant from seeing, changing or deleting a rule (RLS)', async () => {
    const repo = makeRouteRepo();
    const row = await repo.create(tenantA, write(channelA));
    expect(await repo.find(tenantB, row.id)).toBeUndefined();
    expect(
      await repo.update(tenantB, row.id, () => ({
        enabled: false,
        changedFields: ['enabled'],
        op: 'updated',
        actorId: userA,
      })),
    ).toBeUndefined();
    expect(await repo.remove(tenantB, row.id, userA)).toBeUndefined();
    expect(await repo.find(tenantA, row.id)).toMatchObject({ enabled: true });
  });

  it('refuses a rule that names another tenant’s channel (composite foreign key)', async () => {
    const repo = makeRouteRepo();
    expect(await pgCode(repo.create(tenantB, write(channelA)))).toBe('23503');
    expect(await pgCode(repo.create(tenantA, write(channelB)))).toBe('23503');
  });

  it('answers the enabled rules that name a channel, so a channel delete is blocked by them', async () => {
    const repo = makeRouteRepo();
    const channel = await channelOf(tenantA);
    const live = await repo.create(tenantA, write(channel));
    const off = await repo.create(tenantA, write(channel, { enabled: false }));
    expect(await repo.enabledRuleIdsForChannel(tenantA, channel)).toEqual([live.id]);
    expect(await repo.enabledRuleIdsForChannel(tenantB, channel)).toEqual([]);
    expect(off.enabled).toBe(false);
  });

  it('enforces the CHECK constraints: an unknown event, a severity or a priority outside its range are refused', async () => {
    const insert = (values: string) =>
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO notification_routes (tenant_id, event, channel_id, created_by, severity_min, priority)
           VALUES ($1, ${values})`,
          [tenantA, channelA, userA],
        ),
      );
    expect(await pgCode(insert(`'made.up', $2, $3, 'info', 0`))).toBe('23514');
    expect(await pgCode(insert(`'*', $2, $3, 'nope', 0`))).toBe('23514');
    expect(await pgCode(insert(`'*', $2, $3, 'info', 5000`))).toBe('23514');
    expect(await pgCode(insert(`'*', $2, $3, 'info', 0`))).toBeUndefined();
  });

  it('writes a changed rule and its audit event together, and a no-op changes and audits nothing', async () => {
    const events: NotificationRouteAuditEvent[] = [];
    const repo = makeRouteRepo(events);
    const row = await repo.create(
      tenantA,
      write(channelA, { event: 'run.failed', severityMin: 'info', priority: 0 }),
    );
    const before = events.length;
    const updated = await repo.update(tenantA, row.id, () => ({
      severityMin: 'high',
      changedFields: ['severityMin'],
      op: 'updated',
      actorId: userA,
    }));
    expect(updated?.changed).toBe(true);
    expect(updated?.record.severityMin).toBe('high');
    const noop = await repo.update(tenantA, row.id, () => undefined);
    expect(noop?.changed).toBe(false);
    expect(events.length).toBe(before + 1);
    expect(events[before]).toMatchObject({ op: 'updated', changedFields: ['severityMin'] });
  });

  it('deletes a rule and audits the deletion', async () => {
    const events: NotificationRouteAuditEvent[] = [];
    const repo = makeRouteRepo(events);
    const row = await repo.create(tenantA, write(channelA));
    expect(await repo.remove(tenantA, row.id, userA)).toMatchObject({ id: row.id });
    expect(await repo.find(tenantA, row.id)).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ op: 'deleted', routeId: row.id });
  });

  it('rolls the rule back when its audit event cannot be written', async () => {
    const repo = makeRouteRepo([], true);
    const before = (await makeRouteRepo().list(tenantA)).length;
    await expect(repo.create(tenantA, write(channelA))).rejects.toThrow('ledger unavailable');
    expect((await makeRouteRepo().list(tenantA)).length).toBe(before);
  });
});
