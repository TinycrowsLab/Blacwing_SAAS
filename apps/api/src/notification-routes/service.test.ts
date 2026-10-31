import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AppError, ForbiddenError, NotFoundError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { routeChannelReferences } from './module.js';
import { NotificationRouteService } from './service.js';
import { NotificationChannelService } from '../notification-channels/service.js';

import type { NotificationRouteStore } from './ports.js';
import type { NotificationChannelStore } from '../notification-channels/ports.js';
import type { NotificationChannelRow, NotificationRouteRow } from '@blackwing/db';

/**
 * The routing rule service (NOTIFY-011) against in-memory fakes that keep the repository's tenant scoping and its
 * locked-update semantics. Covers authorisation, validation, the active-channel guard, change detection and audit
 * counting, the channel-delete guard that a rule triggers, and cross-tenant invisibility. The Postgres adapter, RLS and
 * the composite foreign key are proven in `packages/db/src/notification-route.rls.int.test.ts`.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ORG_ADMIN = randomUUID();
const DEVELOPER = randomUUID();
const OUTSIDER = randomUUID();
const ADMIN_B = randomUUID();

const ROLES: Record<string, Record<string, readonly string[]>> = {
  [TENANT_A]: { [ORG_ADMIN]: ['org_admin'], [DEVELOPER]: ['developer'] },
  [TENANT_B]: { [ADMIN_B]: ['org_admin'] },
};

function memberships() {
  return {
    rolesOf: (tenantId: string, userId: string) => Promise.resolve(ROLES[tenantId]?.[userId] ?? []),
  };
}

function channel(
  tenantId: string,
  status: 'active' | 'disabled' = 'active',
): NotificationChannelRow {
  const now = new Date('2026-10-30T09:00:00Z');
  return {
    id: newId(),
    tenantId,
    kind: 'email',
    name: `channel ${randomUUID().slice(0, 6)}`,
    config: { addresses: ['sec@example.com'] },
    secretRef: null,
    status,
    createdBy: ORG_ADMIN,
    createdAt: now,
    updatedAt: now,
  };
}

/** A route store with the repository's semantics: tenant-scoped reads and writes, a locked update, no-op detection. */
function routeStore() {
  const rows = new Map<string, NotificationRouteRow>();
  const store: NotificationRouteStore = {
    list: (tenantId) =>
      Promise.resolve([...rows.values()].filter((row) => row.tenantId === tenantId)),
    find: (tenantId, routeId) => {
      const row = rows.get(routeId);
      return Promise.resolve(row?.tenantId === tenantId ? row : undefined);
    },
    create: (tenantId, write) => {
      const now = new Date('2026-10-30T09:00:00Z');
      const row: NotificationRouteRow = {
        id: write.id,
        tenantId,
        event: write.event,
        assetId: write.assetId,
        severityMin: write.severityMin,
        channelId: write.channelId,
        recipientSpec: write.recipientSpec,
        enabled: write.enabled,
        priority: write.priority,
        createdBy: write.createdBy,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return Promise.resolve(row);
    },
    update: (tenantId, routeId, mutate) => {
      const current = rows.get(routeId);
      if (current?.tenantId !== tenantId) return Promise.resolve(undefined);
      const write = mutate(current);
      if (write === undefined) return Promise.resolve({ record: current, changed: false });
      const record: NotificationRouteRow = {
        ...current,
        ...(write.event === undefined ? {} : { event: write.event }),
        ...(write.assetId === undefined ? {} : { assetId: write.assetId }),
        ...(write.severityMin === undefined ? {} : { severityMin: write.severityMin }),
        ...(write.channelId === undefined ? {} : { channelId: write.channelId }),
        ...(write.recipientSpec === undefined ? {} : { recipientSpec: write.recipientSpec }),
        ...(write.enabled === undefined ? {} : { enabled: write.enabled }),
        ...(write.priority === undefined ? {} : { priority: write.priority }),
      };
      rows.set(routeId, record);
      return Promise.resolve({ record, changed: true });
    },
    remove: (tenantId, routeId) => {
      const current = rows.get(routeId);
      if (current?.tenantId !== tenantId) return Promise.resolve(undefined);
      rows.delete(routeId);
      return Promise.resolve(current);
    },
    enabledRuleIdsForChannel: (tenantId, channelId) =>
      Promise.resolve(
        [...rows.values()]
          .filter((row) => row.tenantId === tenantId && row.channelId === channelId && row.enabled)
          .map((row) => row.id),
      ),
  };
  return { store, rows };
}

/** A channel lookup over a fixed list of channel rows. */
function channelLookup(rows: readonly NotificationChannelRow[]) {
  return {
    find: (tenantId: string, channelId: string) =>
      Promise.resolve(rows.find((row) => row.tenantId === tenantId && row.id === channelId)),
  };
}

function harness(channels: readonly NotificationChannelRow[]) {
  const { store, rows } = routeStore();
  const ops: string[] = [];
  const logs: unknown[] = [];
  const service = new NotificationRouteService({
    store,
    channels: channelLookup(channels),
    memberships: memberships(),
    metrics: { changed: (op) => ops.push(op) },
    logger: { info: (fields: unknown) => logs.push(fields) },
  });
  return { service, rows, ops, logs };
}

const admin = (tenantId: string) => ({ tenantId, actorId: ORG_ADMIN });

describe('NotificationRouteService', () => {
  it('creates a rule for an active channel of the tenant, counting and logging the change', async () => {
    const active = channel(TENANT_A);
    const { service, ops, logs } = harness([active]);
    const view = await service.create(admin(TENANT_A), {
      event: 'kill.fired',
      severityMin: 'critical',
      channelId: active.id,
      recipientSpec: { onCallGroup: 'soc-primary' },
      priority: 5,
    });
    expect(view).toMatchObject({
      event: 'kill.fired',
      assetId: null,
      severityMin: 'critical',
      channelId: active.id,
      enabled: true,
      priority: 5,
    });
    expect(ops).toEqual(['created']);
    expect(logs).toEqual([
      expect.objectContaining({
        tenantId: TENANT_A,
        routeId: view.id,
        channelId: active.id,
        op: 'created',
      }),
    ]);
  });

  it('refuses a rule that names a disabled channel', async () => {
    const disabled = channel(TENANT_A, 'disabled');
    const { service, ops } = harness([disabled]);
    await expect(
      service.create(admin(TENANT_A), { event: '*', channelId: disabled.id }),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_ROUTE_INVALID' });
    expect(ops).toEqual([]);
  });

  it('refuses a rule that names a channel of another tenant, as if it did not exist', async () => {
    const otherTenant = channel(TENANT_B);
    const { service } = harness([otherTenant]);
    const error = await service
      .create(admin(TENANT_A), { event: '*', channelId: otherTenant.id })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('NOTIFICATION_ROUTE_INVALID');
  });

  it('refuses a body with an unknown field, naming the field and not echoing its value', async () => {
    const active = channel(TENANT_A);
    const { service } = harness([active]);
    const error = await service
      .create(admin(TENANT_A), {
        event: '*',
        channelId: active.id,
        webhookUrl: 'https://secret.example/x',
      })
      .catch((e: unknown) => e as AppError);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).detail).toContain('Invalid fields');
    expect((error as AppError).detail).not.toContain('secret.example');
  });

  it('refuses a caller without notifications:manage (a developer) and an outsider with no roles', async () => {
    const active = channel(TENANT_A);
    const { service, ops } = harness([active]);
    await expect(
      service.create(
        { tenantId: TENANT_A, actorId: DEVELOPER },
        { event: '*', channelId: active.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.create(
        { tenantId: TENANT_A, actorId: OUTSIDER },
        { event: '*', channelId: active.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(ops).toEqual([]);
  });

  it('fails closed for a caller whose id is not a uuid, since it holds no membership', async () => {
    const active = channel(TENANT_A);
    const { service } = harness([active]);
    await expect(
      service.create(
        { tenantId: TENANT_A, actorId: 'usr_none' },
        { event: '*', channelId: active.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('changes only the fields sent, and an unchanged body is a no-op that is not counted or logged', async () => {
    const active = channel(TENANT_A);
    const { service, ops, logs } = harness([active]);
    const created = await service.create(admin(TENANT_A), {
      event: 'run.failed',
      channelId: active.id,
    });
    const before = ops.length;
    const changed = await service.update(admin(TENANT_A), created.id, { enabled: false });
    expect(changed).toMatchObject({ enabled: false, event: 'run.failed', priority: 0 });
    expect(ops.slice(before)).toEqual(['updated']);
    const logCount = logs.length;
    const same = await service.update(admin(TENANT_A), created.id, { enabled: false });
    expect(same.enabled).toBe(false);
    expect(ops.slice(before)).toEqual(['updated']);
    expect(logs.length).toBe(logCount);
  });

  it('refuses a change that moves a rule to a disabled channel', async () => {
    const active = channel(TENANT_A);
    const disabled = channel(TENANT_A, 'disabled');
    const { service } = harness([active, disabled]);
    const created = await service.create(admin(TENANT_A), { event: '*', channelId: active.id });
    await expect(
      service.update(admin(TENANT_A), created.id, { channelId: disabled.id }),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_ROUTE_INVALID' });
  });

  it('refuses an empty patch', async () => {
    const active = channel(TENANT_A);
    const { service } = harness([active]);
    const created = await service.create(admin(TENANT_A), { event: '*', channelId: active.id });
    await expect(service.update(admin(TENANT_A), created.id, {})).rejects.toMatchObject({
      code: 'NOTIFICATION_ROUTE_INVALID',
    });
  });

  it('treats a rule of another tenant as not found, for read, change and delete', async () => {
    const active = channel(TENANT_A);
    const { service } = harness([active]);
    const created = await service.create(admin(TENANT_A), { event: '*', channelId: active.id });
    const other = { tenantId: TENANT_B, actorId: ADMIN_B };
    await expect(service.get(other, created.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.update(other, created.id, { enabled: false })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.remove(other, created.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await service.list(admin(TENANT_A))).toHaveLength(1);
  });

  it('deletes a rule, and a second delete is not found', async () => {
    const active = channel(TENANT_A);
    const { service, rows, ops } = harness([active]);
    const created = await service.create(admin(TENANT_A), { event: '*', channelId: active.id });
    const removed = await service.remove(admin(TENANT_A), created.id);
    expect(removed.id).toBe(created.id);
    expect(rows.size).toBe(0);
    expect(ops).toEqual(['created', 'deleted']);
    await expect(service.remove(admin(TENANT_A), created.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a malformed route id as not found', async () => {
    const { service } = harness([]);
    await expect(service.get(admin(TENANT_A), 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('a routing rule guards the channel delete (NOTIFY-001)', () => {
  /** A channel service over one channel row; `update` records whether a disable was attempted. */
  function channelService(
    row: NotificationChannelRow,
    references: ReturnType<typeof routeChannelReferences>,
  ) {
    let disabled = false;
    const store: NotificationChannelStore = {
      list: () => Promise.resolve([row]),
      find: (tenantId, channelId) =>
        Promise.resolve(tenantId === row.tenantId && channelId === row.id ? row : undefined),
      create: () => Promise.reject(new Error('unused')),
      update: (_tenantId, _channelId, mutate) => {
        const write = mutate(row);
        disabled = write?.status === 'disabled';
        return Promise.resolve({ record: row, changed: write !== undefined });
      },
    };
    const service = new NotificationChannelService({
      store,
      memberships: memberships(),
      secrets: { encryptSecret: () => Promise.reject(new Error('unused')) },
      references,
      metrics: { changed: () => undefined },
      logger: { info: () => undefined },
    });
    return { service, wasDisabled: () => disabled };
  }

  it('blocks disabling a channel that an enabled rule names, unless forced', async () => {
    const row = channel(TENANT_A);
    const { store } = routeStore();
    await store.create(TENANT_A, {
      id: newId(),
      event: '*',
      assetId: null,
      severityMin: 'info',
      channelId: row.id,
      recipientSpec: {},
      enabled: true,
      priority: 0,
      createdBy: ORG_ADMIN,
    });
    const { service, wasDisabled } = channelService(row, routeChannelReferences(store));
    await expect(
      service.remove({ tenantId: TENANT_A, actorId: ORG_ADMIN }, row.id, {}),
    ).rejects.toMatchObject({ code: 'CHANNEL_REFERENCED' });
    expect(wasDisabled()).toBe(false);
    await service.remove({ tenantId: TENANT_A, actorId: ORG_ADMIN }, row.id, { force: 'true' });
    expect(wasDisabled()).toBe(true);
  });

  it('does not block on a disabled rule', async () => {
    const row = channel(TENANT_A);
    const { store } = routeStore();
    await store.create(TENANT_A, {
      id: newId(),
      event: '*',
      assetId: null,
      severityMin: 'info',
      channelId: row.id,
      recipientSpec: {},
      enabled: false,
      priority: 0,
      createdBy: ORG_ADMIN,
    });
    const { service, wasDisabled } = channelService(row, routeChannelReferences(store));
    await service.remove({ tenantId: TENANT_A, actorId: ORG_ADMIN }, row.id, {});
    expect(wasDisabled()).toBe(true);
  });
});
