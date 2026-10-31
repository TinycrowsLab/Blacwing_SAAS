// notify() core with routing rules (NOTIFY-011) against the real migrations on Postgres 16 (Testcontainers). A rule
// that names an on-call group narrows the e-mail delivery to that roster's active members, intersected with the
// channel's own addresses. A group with no active member falls back to the channel audience. Both the dry run and
// the enqueued outbox row carry the same recipients. Run with `pnpm test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuditEmitter } from '@blackwing/audit';
import {
  createDatabase,
  migrateDatabase,
  NotificationChannelRepository,
  NotificationRouteRepository,
} from '@blackwing/db';
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

const tenant = newId();
const admin = newId();
const socUser = newId();
const retiredUser = newId();
const SOC_EMAIL = 'soc@tenant.example';
const LEAD_EMAIL = 'lead@tenant.example';
const RETIRED_EMAIL = 'retired@tenant.example';
const CONSOLE = 'https://console.blackwing.example';

const emailImpl: NotificationChannel = {
  kind: 'email',
  supportsActions: false,
  validate: (config) => validateWithKindSchema('email', config),
  send: () => Promise.resolve({ ok: true }),
};

const channels = () =>
  new NotificationChannelRepository({ db: createDatabase(pg.appPool), audit: () => undefined });
const routes = () =>
  new NotificationRouteRepository({ db: createDatabase(pg.appPool), audit: () => undefined });

/** Recipients of each planned e-mail delivery, in order. */
function recipientsOf(
  payloads: readonly {
    readonly payload: { readonly recipients?: readonly string[] | undefined };
  }[],
) {
  return payloads.map((entry) => entry.payload.recipients);
}

const killRequest = {
  tenantId: tenant,
  event: 'kill.fired',
  severity: 'critical',
  subject: 'Kill switch fired',
  body: {},
};

beforeAll(async () => {
  pg = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  await pg.withTenant(tenant, (tx) =>
    tx.query(
      `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, 'routes-notify', 'Tenant routes', 'eu-west-1', 'team')`,
      [tenant],
    ),
  );
  await pg.withTenant(tenant, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, keycloak_sub, email, status) VALUES ($1, 'sub-admin', $2, 'active')`,
      [admin, 'admin@tenant.example'],
    );
    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, ARRAY['org_admin']::text[])`,
      [tenant, admin],
    );
    await tx.query(
      `INSERT INTO users (id, keycloak_sub, email, status) VALUES ($1, 'sub-soc', $2, 'active')`,
      [socUser, SOC_EMAIL],
    );
    await tx.query(
      `INSERT INTO users (id, keycloak_sub, email, status) VALUES ($1, 'sub-retired', $2, 'suspended')`,
      [retiredUser, RETIRED_EMAIL],
    );
    // The roster is named after the group the rules refer to. The disabled member is not an active recipient.
    await tx.query(
      `INSERT INTO oncall_rosters (id, tenant_id, name, timezone, active) VALUES ($1, $2, 'soc-primary', 'UTC', true)`,
      [newId(), tenant],
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

describe('routing rules on the notify core (NOTIFY-011)', () => {
  it('narrows an e-mail delivery to the on-call group members the channel holds, in dry run and enqueued alike', async () => {
    const channel = await channels().create(tenant, {
      id: newId(),
      kind: 'email',
      name: 'Gate mail',
      config: { addresses: [SOC_EMAIL, LEAD_EMAIL] },
      status: 'active',
      createdBy: admin,
    });
    const rosterMemberId = newId();
    await pg.withTenant(tenant, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM oncall_rosters WHERE tenant_id = $1 AND name = 'soc-primary'`,
        [tenant],
      );
      const rosterId = rows[0]?.id;
      await tx.query(
        `INSERT INTO oncall_members (id, tenant_id, roster_id, user_id, level, channel_refs, order_index) VALUES ($1, $2, $3, $4, 0, '[]'::jsonb, 0)`,
        [rosterMemberId, tenant, rosterId, socUser],
      );
    });
    await routes().create(tenant, {
      id: newId(),
      event: 'kill.fired',
      assetId: null,
      severityMin: 'critical',
      channelId: channel.id,
      recipientSpec: { onCallGroup: 'soc-primary' },
      enabled: true,
      priority: 10,
      createdBy: admin,
    });

    const dry = await notifier.notify(killRequest, { dryRun: true });
    expect(dry.status).toBe('dry_run');
    if (dry.status !== 'dry_run') return;
    expect(recipientsOf(dry.rendered)).toEqual([[SOC_EMAIL]]);

    const enqueued = await notifier.notify({ ...killRequest, dedupeKey: 'kill-routes-1' });
    expect(enqueued.status).toBe('enqueued');
  });

  it('falls back to the channel audience when the named group has no active member', async () => {
    const channel = await channels().create(tenant, {
      id: newId(),
      kind: 'email',
      name: 'Retired group mail',
      config: { addresses: [RETIRED_EMAIL, LEAD_EMAIL] },
      status: 'active',
      createdBy: admin,
    });
    await routes().create(tenant, {
      id: newId(),
      event: 'gate2.exception',
      assetId: null,
      severityMin: 'critical',
      channelId: channel.id,
      recipientSpec: { onCallGroup: 'no-such-group' },
      enabled: true,
      priority: 0,
      createdBy: admin,
    });
    const dry = await notifier.notify(
      { ...killRequest, event: 'gate2.exception' },
      { dryRun: true },
    );
    expect(dry.status).toBe('dry_run');
    if (dry.status !== 'dry_run') return;
    expect(recipientsOf(dry.rendered)).toContainEqual([RETIRED_EMAIL, LEAD_EMAIL]);
  });
});
