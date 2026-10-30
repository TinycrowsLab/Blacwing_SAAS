// The on-call roster store against the real migrations on Postgres (Testcontainers): round trip of the
// lists, one active roster and name uniqueness as conflicts, optimistic concurrency, the audit event
// committed with its write (and rolled back with it), and cross-tenant isolation. Needs Docker; run with
// `pnpm --filter @blackwing/api test:int`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type Database, migrateDatabase } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { PostgresOncallAuditSink, PostgresOncallStore } from './postgres.js';

import type { AuditEventInput } from '@blackwing/audit';
import type { OncallRoster } from '@blackwing/contracts';

let pg: PostgresHandle;
let database: Database;
let store: PostgresOncallStore;
// Each test gets its own tenants, so one test's active roster never conflicts with another's.
let tenantA = newId();
let tenantB = newId();
const NOW = '2026-10-30T10:00:00.000Z';

function roster(overrides: Partial<OncallRoster> = {}): OncallRoster {
  const userId = newId();
  return {
    id: newId(),
    tenantId: tenantA,
    name: `roster-${newId()}`,
    timezone: 'Europe/Berlin',
    active: true,
    stateVersion: 0,
    members: [{ id: newId(), userId, level: 0, orderIndex: 0, channelRefs: [newId()] }],
    schedules: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function audit(
  tenantId: string,
  action: AuditEventInput['action'] = 'oncall.roster.updated',
): AuditEventInput {
  return {
    tenantId,
    action,
    actor: { type: 'user', id: newId() },
    target: { type: 'config', id: newId() },
    outcome: 'success',
    metadata: { change: 'created' },
  };
}

/** Counts ledger rows as the tenant (the audit table is tenant-scoped under RLS). */
async function auditCount(tenantId: string, action: string): Promise<number> {
  const client = await pg.appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM audit_events WHERE tenant_id = $1 AND action = $2',
      [tenantId, action],
    );
    await client.query('COMMIT');
    return Number(result.rows[0]?.n ?? 0);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(() => {
  tenantA = newId();
  tenantB = newId();
});

beforeAll(async () => {
  pg = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  database = createDatabase(pg.appPool);
  store = new PostgresOncallStore(database);
});

afterAll(async () => {
  await pg.stop();
});

describe('PostgresOncallStore', () => {
  it('round-trips a roster with its ordered members and schedule windows', async () => {
    const first = roster({ name: 'Round trip' });
    const second = newId();
    const withLists: OncallRoster = {
      ...first,
      members: [
        { id: newId(), userId: second, level: 1, orderIndex: 0, channelRefs: [] },
        ...first.members,
      ],
      schedules: [
        {
          id: newId(),
          userId: first.members[0]?.userId ?? second,
          startsAt: '2026-10-30T08:00:00.000Z',
          endsAt: '2026-10-30T16:00:00.000Z',
        },
      ],
    };
    const inserted = await store.insert(withLists, audit(tenantA));
    expect(inserted.kind).toBe('created');

    const read = await store.get(tenantA, withLists.id);
    expect(read).toMatchObject({
      id: withLists.id,
      name: 'Round trip',
      timezone: 'Europe/Berlin',
      active: true,
      stateVersion: 0,
    });
    // Members come back in escalation order: level, then order_index.
    expect(read?.members.map((m) => [m.level, m.orderIndex])).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(read?.members[1]?.channelRefs).toEqual([]);
    expect(read?.schedules).toEqual([
      expect.objectContaining({
        startsAt: '2026-10-30T08:00:00.000Z',
        endsAt: '2026-10-30T16:00:00.000Z',
      }),
    ]);
  });

  it('refuses a second active roster as active_roster_exists, and a duplicate name as name_taken', async () => {
    const active = roster({ name: 'Active one' });
    expect((await store.insert(active, audit(tenantA))).kind).toBe('created');

    expect(await store.insert(roster({ name: 'Active two' }), audit(tenantA))).toEqual({
      kind: 'conflict',
      reason: 'active_roster_exists',
    });
    expect(
      await store.insert(roster({ name: 'Active one', active: false }), audit(tenantA)),
    ).toEqual({ kind: 'conflict', reason: 'name_taken' });
  });

  it('updates under compare-and-set: a stale version is refused and nothing changes', async () => {
    const base = roster({ name: 'Versioned', active: false });
    await store.insert(base, audit(tenantA));

    const first = await store.update(
      { ...base, name: 'Versioned A', stateVersion: 0 },
      0,
      audit(tenantA, 'oncall.roster.updated'),
    );
    expect(first).toMatchObject({
      kind: 'updated',
      roster: { stateVersion: 1, name: 'Versioned A' },
    });

    const stale = await store.update(
      { ...base, name: 'Versioned B', stateVersion: 0 },
      0,
      audit(tenantA),
    );
    expect(stale).toEqual({ kind: 'stale' });
    expect((await store.get(tenantA, base.id))?.name).toBe('Versioned A');
  });

  it('replaces the member and schedule lists on update', async () => {
    const base = roster({ name: 'Replaced', active: false });
    await store.insert(base, audit(tenantA));
    const replacement = newId();

    await store.update(
      {
        ...base,
        stateVersion: 0,
        members: [{ id: newId(), userId: replacement, level: 2, orderIndex: 3, channelRefs: [] }],
        schedules: [],
      },
      0,
      audit(tenantA),
    );

    const read = await store.get(tenantA, base.id);
    expect(read?.members.map((m) => m.userId)).toEqual([replacement]);
    expect(read?.schedules).toEqual([]);
  });

  it('commits the audit event with the write, once per write', async () => {
    const before = await auditCount(tenantA, 'oncall.roster.updated');
    const committed = roster({ name: 'Audited' });
    await store.insert(committed, audit(tenantA));
    expect(await auditCount(tenantA, 'oncall.roster.updated')).toBe(before + 1);
  });

  it('rolls the write back when its audit event cannot be stored (fail closed, §8.8)', async () => {
    const rejected = roster({ name: 'Never stored' });
    // An action outside the catalogue makes the ledger refuse the event; the roster must not be stored.
    const invalid = audit(tenantA, 'not.a.catalogue.action' as AuditEventInput['action']);

    await expect(store.insert(rejected, invalid)).rejects.toThrow();
    expect(await store.get(tenantA, rejected.id)).toBeNull();
    expect(await store.list(tenantA)).not.toContainEqual(
      expect.objectContaining({ id: rejected.id }),
    );
  });

  it('isolates tenants: another tenant cannot read, list or update a roster', async () => {
    const mine = roster({ name: 'Tenant A only', active: false });
    await store.insert(mine, audit(tenantA));

    expect(await store.get(tenantB, mine.id)).toBeNull();
    expect(await store.list(tenantB)).toEqual([]);
    expect(await store.getActive(tenantB)).toBeNull();
    expect(
      await store.update({ ...mine, tenantId: tenantB, stateVersion: 0 }, 0, audit(tenantB)),
    ).toEqual({ kind: 'stale' });
    expect((await store.get(tenantA, mine.id))?.name).toBe('Tenant A only');
  });

  it('finds the one active roster of a tenant', async () => {
    const tenant = newId();
    const active = roster({ tenantId: tenant, name: 'Only active' });
    await store.insert(active, audit(tenant));
    expect((await store.getActive(tenant))?.id).toBe(active.id);
  });
});

describe('PostgresOncallAuditSink', () => {
  it('appends a sod_skipped event in its own tenant transaction', async () => {
    const sink = new PostgresOncallAuditSink(database);
    const before = await auditCount(tenantA, 'oncall.sod_skipped');
    await sink.append({
      action: 'oncall.sod_skipped',
      tenantId: tenantA,
      actor: { type: 'system' },
      target: { type: 'run', id: newId() },
      outcome: 'success',
      metadata: { level: 0 },
    });
    expect(await auditCount(tenantA, 'oncall.sod_skipped')).toBe(before + 1);
  });
});
