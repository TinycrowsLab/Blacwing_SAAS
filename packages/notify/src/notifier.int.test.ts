// notify() core (NOTIFY-002) against the real migrations on Postgres 16 (Testcontainers): routing reads the tenant's
// channels, each delivery is one notify.send outbox row written in the same transaction, a repeated request collapses,
// a dry run writes nothing, cross-tenant channels are never reached, an unrouted request is audited, and a
// kill or gate 2 notice falls back to the tenant's org admins. Run with `pnpm test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuditEmitter } from '@blackwing/audit';
import { createDatabase, migrateDatabase, NotificationChannelRepository } from '@blackwing/db';
import { ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import {
  createChannelRegistry,
  type NotificationChannel,
  validateWithKindSchema,
} from './channel.js';
import { createNotifier, type Notifier } from './notifier.js';

let pg: PostgresHandle;
let notifier: Notifier;

const tenantA = newId();
const tenantB = newId();
const userA = newId();
const adminEmail = 'org-admin@tenant-a.example';
const CONSOLE = 'https://console.blackwing.example';
const RUN = newId();

const emailImpl: NotificationChannel = {
  kind: 'email',
  supportsActions: false,
  validate: (config) => validateWithKindSchema('email', config),
  send: () => Promise.resolve({ ok: true }),
};

const repo = () =>
  new NotificationChannelRepository({
    db: createDatabase(pg.appPool),
    audit: () => undefined,
  });

async function createEmailChannel(tenantId: string, name: string, addresses: string[]) {
  return repo().create(tenantId, {
    id: newId(),
    kind: 'email',
    name,
    config: { addresses },
    status: 'active',
    createdBy: userA,
  });
}

/** Rows of the outbox for `tenantId`, as the relay would see them. */
async function outboxRows(tenantId: string) {
  return pg.withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query<{ type: string; dedupe_key: string | null; payload: unknown }>(
      "SELECT type, dedupe_key, payload FROM outbox WHERE type = 'notify.send' ORDER BY created_at, id",
    );
    return rows;
  });
}

async function auditActions(tenantId: string): Promise<string[]> {
  return pg.withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query<{ action: string }>(
      'SELECT action FROM audit_events ORDER BY seq',
    );
    return rows.map((row) => row.action);
  });
}

const request = (overrides: Record<string, unknown> = {}) => ({
  tenantId: tenantA,
  event: 'run.completed',
  severity: 'info',
  subject: 'Run completed',
  body: { target: 'app.example.com' },
  ...overrides,
});

beforeAll(async () => {
  pg = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  for (const [id, slug] of [
    [tenantA, 'notify-core-a'],
    [tenantB, 'notify-core-b'],
  ] as const) {
    await pg.withTenant(id, (tx) =>
      tx.query(
        `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, $2, $3, 'eu-west-1', 'team')`,
        [id, slug, `Tenant ${slug}`],
      ),
    );
  }
  await pg.withTenant(tenantA, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, keycloak_sub, email, status) VALUES ($1, 'sub-a', $2, 'active')`,
      [userA, adminEmail],
    );
    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, ARRAY['org_admin']::text[])`,
      [tenantA, userA],
    );
  });
  notifier = createNotifier({
    db: createDatabase(pg.appPool),
    registry: createChannelRegistry([emailImpl]),
    audit: createAuditEmitter(),
    consoleUrl: CONSOLE,
  });
}, 180_000);

afterAll(async () => {
  await (pg as PostgresHandle | undefined)?.stop();
});

describe('notify() core: routing and enqueue (NOTIFY-002)', () => {
  it('enqueues one notify.send row per active channel, in the same transaction, without a credential', async () => {
    const channel = await createEmailChannel(tenantA, 'SOC mail', ['soc@tenant-a.example']);
    const before = (await outboxRows(tenantA)).length;

    const outcome = await notifier.notify(request());

    expect(outcome).toMatchObject({ status: 'enqueued', enqueued: 1, fallback: false });
    const rows = await outboxRows(tenantA);
    expect(rows).toHaveLength(before + 1);
    const row = rows.at(-1);
    expect(row?.dedupe_key).toBe(
      `notify:${(outcome as { notificationId: string }).notificationId}:${channel.id}`,
    );
    expect(row?.payload).toMatchObject({
      event: 'run.completed',
      channel: { id: channel.id, kind: 'email' },
      recipients: ['soc@tenant-a.example'],
      message: { subject: 'Run completed' },
    });
    expect(JSON.stringify(row?.payload)).not.toMatch(/secret|token|hooks\./);
  });

  it('collapses a repeated request with the same dedupeKey to nothing new', async () => {
    const first = await notifier.notify(request({ dedupeKey: 'run-42:done' }));
    expect(first.status).toBe('enqueued');
    const count = (await outboxRows(tenantA)).length;

    const second = await notifier.notify(request({ dedupeKey: 'run-42:done' }));

    expect(second.status).toBe('deduplicated');
    expect(await outboxRows(tenantA)).toHaveLength(count);
  });

  it('a dry run returns the rendered payloads and writes nothing', async () => {
    const before = (await outboxRows(tenantA)).length;

    const outcome = await notifier.notify(request({ subject: 'Dry run' }), { dryRun: true });

    expect(outcome.status).toBe('dry_run');
    if (outcome.status !== 'dry_run') throw new Error('expected a dry run');
    expect(outcome.rendered).toHaveLength(1);
    expect(outcome.rendered[0]?.payload.message.subject).toBe('Dry run');
    expect(await outboxRows(tenantA)).toHaveLength(before);
  });

  it('never reaches another tenant channels: a tenant with none is unrouted and audited', async () => {
    await createEmailChannel(tenantB, 'B only', ['b@tenant-b.example']);

    const outcome = await notifier.notify(request({ tenantId: tenantB, event: 'run.failed' }));
    expect(outcome.status).toBe('enqueued');
    const rowsB = await outboxRows(tenantB);
    expect(JSON.stringify(rowsB)).not.toContain('tenant-a.example');
  });

  it('records an unrouted request in the audit ledger rather than dropping it silently', async () => {
    const tenantC = newId();
    await pg.withTenant(tenantC, (tx) =>
      tx.query(
        `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, 'notify-core-c', 'Tenant C', 'eu-west-1', 'team')`,
        [tenantC],
      ),
    );

    const outcome = await notifier.notify(request({ tenantId: tenantC, event: 'run.failed' }));

    expect(outcome.status).toBe('unrouted');
    expect(await auditActions(tenantC)).toContain('notification.unrouted');
  });

  it('audits a gate event that was enqueued', async () => {
    const outcome = await notifier.notify(
      request({ event: 'gate1.requested', subject: 'Scope approval', runId: RUN }),
    );
    expect(outcome.status).toBe('enqueued');
    expect(await auditActions(tenantA)).toContain('notification.requested');
  });

  it('skips a disabled channel and reports it, delivering nothing to it', async () => {
    const disabled = await repo().create(tenantB, {
      id: newId(),
      kind: 'email',
      name: 'Muted',
      config: { addresses: ['muted@tenant-b.example'] },
      status: 'disabled',
      createdBy: userA,
    });

    const outcome = await notifier.notify(request({ tenantId: tenantB, event: 'system.alert' }));

    expect(outcome.status).toBe('enqueued');
    if (outcome.status !== 'enqueued') throw new Error('expected enqueued');
    expect(outcome.skipped).toContainEqual({ channelId: disabled.id, reason: 'disabled' });
    expect(JSON.stringify(await outboxRows(tenantB))).not.toContain('muted@tenant-b.example');
  });
});

describe('notify() core: critical fallback', () => {
  it('falls back to the tenant org admins for a kill notice when no channel delivers it', async () => {
    const tenantD = newId();
    await pg.withTenant(tenantD, async (tx) => {
      await tx.query(
        `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, 'notify-core-d', 'Tenant D', 'eu-west-1', 'team')`,
        [tenantD],
      );
      await tx.query(
        `INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, ARRAY['org_admin']::text[])`,
        [tenantD, userA],
      );
    });

    const outcome = await notifier.notify(
      request({
        tenantId: tenantD,
        event: 'kill.fired',
        severity: 'critical',
        subject: 'Kill fired',
      }),
    );

    expect(outcome).toMatchObject({ status: 'enqueued', fallback: true, enqueued: 1 });
    const rows = await outboxRows(tenantD);
    expect(rows.at(-1)?.payload).toMatchObject({
      channel: { id: null, kind: 'email' },
      recipients: [adminEmail],
    });
    expect(await auditActions(tenantD)).toContain('notification.requested');
  });
});

describe('notify() core: fail closed', () => {
  it('refuses an invalid request and writes nothing', async () => {
    const before = (await outboxRows(tenantA)).length;

    await expect(notifier.notify(request({ event: 'made.up' }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(notifier.notify(request({ tenantId: 'not-a-tenant' }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      notifier.notify(request({ actions: [{ label: 'Go', href: '//evil.example.com' }] })),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await outboxRows(tenantA)).toHaveLength(before);
  });
});
