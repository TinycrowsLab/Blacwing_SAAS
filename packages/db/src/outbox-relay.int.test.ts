// The relay's storage side against the real migrations on Postgres 16 (Testcontainers): the bw_relay
// role's reach, SKIP LOCKED concurrency, per-aggregate ordering, backoff on the database clock and the
// rollback that makes delivery at-least-once.

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, type Database } from './client.js';
import { migrateDatabase } from './migrate.js';
import { outboxBacklog, withOutboxClaim } from './outbox-relay.js';

let db: PostgresHandle;
let relayPool: pg.Pool;
let relay: Database;
let app: Database;
const tenantA = newId();
const tenantB = newId();
let clock = Date.parse('2026-01-01T00:00:00Z');

/** Inserts a pending row as its tenant (the app role), with a strictly increasing created_at. */
async function seed(
  tenantId: string,
  over: { aggregateId?: string | null; type?: string } = {},
): Promise<string> {
  const id = newId();
  clock += 1_000;
  await db.withTenant(tenantId, (tx) =>
    tx.query(
      `INSERT INTO outbox (id, tenant_id, type, aggregate_type, aggregate_id, payload, created_at)
       VALUES ($1, $2, $3, 'run', $4, '{"k": 1}'::jsonb, $5)`,
      [id, tenantId, over.type ?? 'notify.send', over.aggregateId ?? null, new Date(clock)],
    ),
  );
  return id;
}

async function row(tenantId: string, id: string) {
  const { rows } = await db.withTenant(tenantId, (tx) =>
    tx.query(
      'SELECT status, attempts, last_error, dispatched_at, available_at > now() AS delayed FROM outbox WHERE id = $1',
      [id],
    ),
  );
  return rows[0] as {
    status: string;
    attempts: number;
    last_error: string | null;
    dispatched_at: Date | null;
    delayed: boolean;
  };
}

const claimIds = (limit = 1_000) =>
  withOutboxClaim(relay, limit, (claim) => Promise.resolve(claim.rows.map((r) => r.id)));

/** Drains the table so each test starts from nothing pending. */
async function drain(): Promise<void> {
  for (;;) {
    const settled = await withOutboxClaim(relay, 1_000, async (claim) => {
      for (const r of claim.rows) await claim.markDispatched(r.id);
      return claim.rows.length;
    });
    if (settled === 0) return;
  }
}

beforeAll(async () => {
  db = await withPostgres({
    migrations: (owner) => migrateDatabase(owner),
  });
  // bw_owner is a member of bw_relay (rls-roles.sql): a session pinned to that role is exactly the
  // relay's reach, without minting a login role in the test.
  relayPool = new pg.Pool({ ...db.connectionConfig('owner'), options: '-c role=bw_relay', max: 8 });
  relay = createDatabase(relayPool);
  app = createDatabase(db.appPool);
});

beforeEach(drain);

/** A raw statement as the relay session would send it: nil tenant pinned, rolled back afterwards. */
async function asRelay(statement: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const client = await relayPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      '00000000-0000-0000-0000-000000000000',
    ]);
    return await client.query(statement, values);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

afterAll(async () => {
  await relayPool.end();
  await db.stop();
});

describe('the bw_relay role', () => {
  it('is a plain RLS subject that sees pending rows of every tenant', async () => {
    const who = await relayPool.query(
      'SELECT current_user AS u, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user',
    );
    expect(who.rows[0]).toEqual({ u: 'bw_relay', rolsuper: false, rolbypassrls: false });
    const a = await seed(tenantA);
    const b = await seed(tenantB);
    const ids = await claimIds();
    expect(ids).toEqual(expect.arrayContaining([a, b]));
    await drain();
  });

  it('cannot insert, delete or change tenant, payload or type', async () => {
    const id = await seed(tenantA);
    for (const statement of [
      `INSERT INTO outbox (id, tenant_id, type, payload) VALUES ('${newId()}', '${tenantA}', 'notify.send', '{}')`,
      `DELETE FROM outbox WHERE id = '${id}'`,
      `UPDATE outbox SET tenant_id = '${tenantB}' WHERE id = '${id}'`,
      `UPDATE outbox SET payload = '{"x": 2}' WHERE id = '${id}'`,
      `UPDATE outbox SET type = 'audit.event' WHERE id = '${id}'`,
    ]) {
      await expect(asRelay(statement), statement).rejects.toMatchObject({
        code: '42501',
      });
    }
    await drain();
  });

  it('cannot touch a row that is no longer pending', async () => {
    const id = await seed(tenantA);
    await withOutboxClaim(relay, 10, (claim) => claim.markDispatched(id));
    const result = await asRelay(`UPDATE outbox SET status = 'pending' WHERE id = $1`, [id]);
    expect(result.rowCount).toBe(0);
    expect((await row(tenantA, id)).status).toBe('dispatched');
  });

  it('is the only non-owner reach: the app role cannot claim across tenants', async () => {
    await seed(tenantA);
    await expect(withOutboxClaim(app, 10, () => Promise.resolve())).rejects.toThrow();
    await drain();
  });
});

describe('claim and settle', () => {
  it('marks a row dispatched on the database clock and never claims it again', async () => {
    const id = await seed(tenantA);
    await withOutboxClaim(relay, 10, (claim) => claim.markDispatched(id));
    const after = await row(tenantA, id);
    expect(after.status).toBe('dispatched');
    expect(after.dispatched_at).toBeInstanceOf(Date);
    expect(await claimIds()).not.toContain(id);
  });

  it('backs a failing row off: attempts + 1, last_error recorded, not due until the delay passes', async () => {
    const id = await seed(tenantA);
    await withOutboxClaim(relay, 10, (claim) => claim.markRetry(id, 'valkey down', 60_000));
    expect(await row(tenantA, id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'valkey down',
      delayed: true,
    });
    expect(await claimIds()).not.toContain(id);
    await db.withTenant(tenantA, (tx) =>
      tx.query(`UPDATE outbox SET available_at = now() - interval '1 second' WHERE id = $1`, [id]),
    );
    expect(await claimIds()).toContain(id);
    await withOutboxClaim(relay, 10, (claim) => claim.markDispatched(id));
  });

  it('lands a permanent failure as failed, and never claims it again', async () => {
    const id = await seed(tenantA);
    await withOutboxClaim(relay, 10, (claim) => claim.markFailed(id, 'tenant_inactive'));
    expect(await row(tenantA, id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'tenant_inactive',
    });
    expect(await claimIds()).not.toContain(id);
  });

  it('rolls every settle back when the callback throws (a crash mid-dispatch): rows stay pending', async () => {
    const id = await seed(tenantA);
    await expect(
      withOutboxClaim(relay, 10, async (claim) => {
        await claim.markDispatched(id);
        throw new Error('crash after the side effect, before commit');
      }),
    ).rejects.toThrow('crash');
    expect(await row(tenantA, id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await claimIds()).toContain(id);
    await drain();
  });

  it('counts the backlog per type', async () => {
    await drain();
    await seed(tenantA, { type: 'notify.send' });
    await seed(tenantB, { type: 'notify.send' });
    await seed(tenantA, { type: 'audit.event' });
    expect(await outboxBacklog(relay)).toEqual({ 'notify.send': 2, 'audit.event': 1 });
    await drain();
  });
});

describe('two relays at once (SKIP LOCKED)', () => {
  it('never hand the same row to both', async () => {
    await drain();
    const seeded = new Set<string>();
    for (let i = 0; i < 12; i += 1) seeded.add(await seed(i % 2 === 0 ? tenantA : tenantB));

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    const holdThenRelease = async (claim: { rows: readonly { id: string }[] }) => {
      held += 1;
      if (held === 2) release();
      await gate; // both claims are open at the same time
      return claim.rows.map((r) => r.id);
    };
    const [first, second] = await Promise.all([
      withOutboxClaim(relay, 6, holdThenRelease),
      withOutboxClaim(relay, 6, holdThenRelease),
    ]);
    expect(first).toHaveLength(6);
    expect(second).toHaveLength(6);
    expect(new Set([...first, ...second]).size).toBe(12);
    for (const id of [...first, ...second]) expect(seeded.has(id)).toBe(true);
    await drain();
  });
});

describe('per-aggregate ordering', () => {
  it('releases only the head of an aggregate, and the next one once the head is done', async () => {
    await drain();
    const aggregate = newId();
    const other = newId();
    const r1 = await seed(tenantA, { aggregateId: aggregate });
    const r2 = await seed(tenantA, { aggregateId: aggregate });
    const r3 = await seed(tenantA, { aggregateId: aggregate });
    const o1 = await seed(tenantA, { aggregateId: other });

    expect(await claimIds()).toEqual([r1, o1]);

    // The head fails and backs off: nothing later in its aggregate may overtake it.
    await withOutboxClaim(relay, 10, (claim) => claim.markRetry(r1, 'x', 60_000));
    expect(await claimIds()).toEqual([o1]);

    // Another relay holds the head: the rest of the aggregate waits for it too (not skipped past).
    await db.withTenant(tenantA, (tx) =>
      tx.query(`UPDATE outbox SET available_at = now() - interval '1 second' WHERE id = $1`, [r1]),
    );
    let seenWhileHeld: string[] = [];
    await withOutboxClaim(relay, 10, async (holder) => {
      expect(holder.rows.map((r) => r.id)).toContain(r1);
      seenWhileHeld = await claimIds();
    });
    // r1 and o1 are locked by the holder; r2 and r3 must not be handed out behind the locked head.
    expect(seenWhileHeld).toEqual([]);

    await withOutboxClaim(relay, 10, (claim) => claim.markDispatched(r1));
    expect(await claimIds()).toEqual([r2, o1]);
    await withOutboxClaim(relay, 10, (claim) => claim.markDispatched(r2));
    expect(await claimIds()).toEqual([r3, o1]);
    await drain();
  });

  it('lets a permanently failed head release the rest of its aggregate (a poison row never blocks)', async () => {
    const aggregate = newId();
    const bad = await seed(tenantA, { aggregateId: aggregate });
    const next = await seed(tenantA, { aggregateId: aggregate });
    await withOutboxClaim(relay, 10, (claim) => claim.markFailed(bad, 'poison'));
    expect(await claimIds()).toEqual([next]);
    await drain();
  });

  it('does not order rows without an aggregate against each other', async () => {
    const a = await seed(tenantA);
    const b = await seed(tenantA);
    expect(await claimIds()).toEqual([a, b]);
    await drain();
  });
});
