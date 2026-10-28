// The outbox relay end to end against Postgres 16 and Valkey 8 (Testcontainers): each destination, retry
// then success, permanent failure (alert + audit), two relays at once, and per-aggregate ordering.
// Temporal itself is a recording fake here (the signal envelope and ordering are what is under test);
// a signal against a real Temporal server is covered by the dev-stack integration suite.

import { Queue } from 'bullmq';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuditEmitter } from '@blackwing/audit';
import { createDatabase, type Database, migrateDatabase } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import {
  type PostgresHandle,
  type ValkeyHandle,
  withPostgres,
  withValkey,
} from '@blackwing/testing/containers';

import { createOutboxDispatchers } from './dispatchers.js';
import { createBullmqNotificationQueue, NOTIFICATIONS_QUEUE } from './notification-queue.js';
import { createOutboxRelay, type OutboxRelay } from './relay.js';

import type { OutboxRelayMetrics } from './ports.js';

let postgres: PostgresHandle;
let valkey: ValkeyHandle;
let relayPool: pg.Pool;
let relayDb: Database;
let appDb: Database;
let queue: ReturnType<typeof createBullmqNotificationQueue>;
let reader: Queue<NotificationJobData>;

const tenantA = newId();
const tenantB = newId();
let clock = Date.parse('2026-01-01T00:00:00Z');

const signals: { workflowId: string; name: string; arg: unknown }[] = [];
let signalFailures = 0;
const metricEvents: string[] = [];
const metrics: OutboxRelayMetrics = {
  dispatched: (type) => metricEvents.push(`dispatched:${type}`),
  failed: (type) => metricEvents.push(`failed:${type}`),
  retried: (type) => metricEvents.push(`retried:${type}`),
  dispatchLatency: () => undefined,
  backlog: () => undefined,
};
const activeTenants = new Set<string>();

function makeRelay(): OutboxRelay {
  return createOutboxRelay({
    config: { batchSize: 100, pollIntervalMs: 20, maxAttempts: 3 },
    relayDb,
    appDb,
    dispatchers: createOutboxDispatchers({
      appDb,
      notifications: queue,
      workflows: {
        getHandle: (workflowId) => ({
          signal: (name, arg) => {
            if (signalFailures > 0) {
              signalFailures -= 1;
              return Promise.reject(new Error('temporal unavailable'));
            }
            signals.push({ workflowId, name, arg });
            return Promise.resolve();
          },
        }),
      },
    }),
    isTenantActive: (tenantId) => Promise.resolve(activeTenants.has(tenantId)),
    audit: createAuditEmitter(),
    metrics,
    random: () => 0,
  });
}

async function seed(
  tenantId: string,
  type: 'audit.event' | 'notify.send' | 'temporal.signal',
  payload: unknown,
  over: { aggregateId?: string; dedupeKey?: string } = {},
): Promise<string> {
  const id = newId();
  clock += 1_000;
  await postgres.withTenant(tenantId, (tx) =>
    tx.query(
      `INSERT INTO outbox (id, tenant_id, type, aggregate_type, aggregate_id, payload, dedupe_key, created_at)
       VALUES ($1, $2, $3, 'run', $4, $5::jsonb, $6, $7)`,
      [
        id,
        tenantId,
        type,
        over.aggregateId ?? null,
        JSON.stringify(payload),
        over.dedupeKey ?? null,
        new Date(clock),
      ],
    ),
  );
  return id;
}

interface NotificationJobData {
  readonly tenantId: string;
  readonly payload: { readonly template?: string };
}

/** Jobs on the notifications queue carrying the given template. */
async function notificationJobs(template: string): Promise<NotificationJobData[]> {
  const jobs = await reader.getJobs(['waiting', 'delayed', 'active', 'completed']);
  return jobs.map((job) => job.data).filter((data) => data.payload.template === template);
}

async function status(tenantId: string, id: string) {
  const { rows } = await postgres.withTenant(tenantId, (tx) =>
    tx.query('SELECT status, attempts, last_error FROM outbox WHERE id = $1', [id]),
  );
  return rows[0] as { status: string; attempts: number; last_error: string | null };
}

/** Makes backed-off rows due again, so a test does not wait out the backoff. */
async function makeDue(tenantId: string): Promise<void> {
  await postgres.withTenant(tenantId, (tx) =>
    tx.query(
      `UPDATE outbox SET available_at = now() - interval '1 second' WHERE status = 'pending'`,
    ),
  );
}

/** `seq` is a bigint column; the raw pg driver returns int8 as a string, so map it as the schema does. */
async function auditRows(tenantId: string): Promise<{ action: string; seq: number }[]> {
  const { rows } = await postgres.withTenant(tenantId, (tx) =>
    tx.query('SELECT action, seq FROM audit_events ORDER BY seq'),
  );
  return (rows as { action: string; seq: string | number }[]).map((row) => ({
    action: row.action,
    seq: Number(row.seq),
  }));
}

async function drain(): Promise<void> {
  for (const tenant of [tenantA, tenantB]) {
    await postgres.withTenant(tenant, (tx) =>
      tx.query(`UPDATE outbox SET status = 'failed' WHERE status = 'pending'`),
    );
  }
}

beforeAll(async () => {
  [postgres, valkey] = await Promise.all([
    withPostgres({ migrations: (owner) => migrateDatabase(owner) }),
    withValkey(),
  ]);
  // bw_owner may SET ROLE to bw_relay without inheriting it: this session is exactly the relay's reach.
  relayPool = new pg.Pool({
    ...postgres.connectionConfig('owner'),
    options: '-c role=bw_relay',
    max: 8,
  });
  relayDb = createDatabase(relayPool);
  appDb = createDatabase(postgres.appPool);
  const connection = { host: valkey.host, port: valkey.port, password: valkey.password };
  queue = createBullmqNotificationQueue(connection);
  reader = new Queue<NotificationJobData>(NOTIFICATIONS_QUEUE, { connection });
});

afterAll(async () => {
  await reader.close();
  await queue.close();
  await relayPool.end();
  await Promise.all([postgres.stop(), valkey.stop()]);
});

beforeEach(async () => {
  await drain();
  signals.length = 0;
  signalFailures = 0;
  metricEvents.length = 0;
  activeTenants.clear();
  activeTenants.add(tenantA);
  activeTenants.add(tenantB);
});

describe('dispatch per type', () => {
  it('appends audit.event rows to the tenant chain, once even when redelivered', async () => {
    const outbox: { payload: unknown }[] = [];
    await createAuditEmitter({
      outbox: { enqueue: (message) => Promise.resolve(void outbox.push(message)) },
    }).emitAudit({
      tenantId: tenantA,
      action: 'auth.login',
      actor: { type: 'user', id: 'u-1' },
      target: { type: 'user', id: 'u-1' },
      outcome: 'success',
      dedupeKey: 'login-1',
    });
    const id = await seed(tenantA, 'audit.event', outbox[0]?.payload);
    expect(await makeRelay().pollOnce()).toBe(1);
    expect((await status(tenantA, id)).status).toBe('dispatched');
    expect(await auditRows(tenantA)).toEqual([{ action: 'auth.login', seq: 1 }]);

    // Crash-after-side-effect: the row is pending again; the chain append is a no-op.
    await postgres.withTenant(tenantA, (tx) =>
      tx.query(`UPDATE outbox SET status = 'pending', dispatched_at = NULL WHERE id = $1`, [id]),
    );
    await makeRelay().pollOnce();
    expect(await auditRows(tenantA)).toEqual([{ action: 'auth.login', seq: 1 }]);
  });

  it('enqueues notify.send rows on the BullMQ notifications queue, deduped across redelivery', async () => {
    const id = await seed(
      tenantA,
      'notify.send',
      { template: 'run_done' },
      { dedupeKey: 'run:1:done' },
    );
    await makeRelay().pollOnce();
    expect((await status(tenantA, id)).status).toBe('dispatched');
    expect(await notificationJobs('run_done')).toEqual([
      { tenantId: tenantA, payload: { template: 'run_done' } },
    ]);

    await postgres.withTenant(tenantA, (tx) =>
      tx.query(`UPDATE outbox SET status = 'pending', dispatched_at = NULL WHERE id = $1`, [id]),
    );
    await makeRelay().pollOnce();
    expect(await notificationJobs('run_done')).toHaveLength(1);
  });

  it('signals the workflow for temporal.signal rows', async () => {
    const id = await seed(
      tenantA,
      'temporal.signal',
      { workflowId: 'run-9', signal: 'gateDecided', input: { ok: true } },
      { dedupeKey: 'g-1' },
    );
    await makeRelay().pollOnce();
    expect((await status(tenantA, id)).status).toBe('dispatched');
    expect(signals).toEqual([
      { workflowId: 'run-9', name: 'gateDecided', arg: { dedupeKey: 'g-1', input: { ok: true } } },
    ]);
  });
});

describe('failure handling', () => {
  it('retries a transient failure with backoff and eventually succeeds', async () => {
    signalFailures = 2;
    const id = await seed(tenantA, 'temporal.signal', { workflowId: 'run-1', signal: 's' });
    const relay = makeRelay();
    await relay.pollOnce();
    expect(await status(tenantA, id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await relay.pollOnce()).toBe(0); // backing off: not due yet
    await makeDue(tenantA);
    await relay.pollOnce();
    expect(await status(tenantA, id)).toMatchObject({ status: 'pending', attempts: 2 });
    await makeDue(tenantA);
    await relay.pollOnce();
    expect(await status(tenantA, id)).toMatchObject({ status: 'dispatched', attempts: 2 });
    expect(signals).toHaveLength(1);
    expect(metricEvents).toEqual([
      'retried:temporal.signal',
      'retried:temporal.signal',
      'dispatched:temporal.signal',
    ]);
  });

  it('lands a permanent failure as failed, raises outbox_failed and audits it', async () => {
    signalFailures = 99;
    const failedAuditsBefore = (await auditRows(tenantA)).filter(
      (row) => row.action === 'outbox.delivery_failed',
    ).length;
    const id = await seed(tenantA, 'temporal.signal', { workflowId: 'run-1', signal: 's' });
    const relay = makeRelay();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await relay.pollOnce();
      await makeDue(tenantA);
    }
    expect(await status(tenantA, id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(metricEvents.filter((event) => event.startsWith('failed:'))).toEqual([
      'failed:temporal.signal',
    ]);
    expect(
      (await auditRows(tenantA)).filter((row) => row.action === 'outbox.delivery_failed'),
    ).toHaveLength(failedAuditsBefore + 1);
    expect(await relay.pollOnce()).toBe(0);
  });

  it('fails a malformed payload (poison) without blocking the rows behind it', async () => {
    const bad = await seed(tenantA, 'temporal.signal', { nope: true });
    const good = await seed(tenantA, 'temporal.signal', { workflowId: 'run-2', signal: 's' });
    const relay = makeRelay();
    await relay.pollOnce();
    expect((await status(tenantA, good)).status).toBe('dispatched');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await makeDue(tenantA);
      await relay.pollOnce();
    }
    expect((await status(tenantA, bad)).status).toBe('failed');
  });

  it('fails the row of an inactive tenant with reason tenant_inactive and delivers nothing', async () => {
    activeTenants.delete(tenantB);
    const id = await seed(tenantB, 'temporal.signal', { workflowId: 'run-3', signal: 's' });
    await makeRelay().pollOnce();
    expect(await status(tenantB, id)).toMatchObject({
      status: 'failed',
      last_error: 'tenant_inactive',
    });
    expect(signals).toHaveLength(0);
  });
});

describe('concurrency and ordering', () => {
  it('never double-dispatches a row across two relay instances', async () => {
    for (let i = 0; i < 30; i += 1) {
      await seed(i % 2 === 0 ? tenantA : tenantB, 'temporal.signal', {
        workflowId: `w-${String(i)}`,
        signal: 's',
      });
    }
    const [a, b] = [makeRelay(), makeRelay()];
    const results = await Promise.all([a.pollOnce(), b.pollOnce(), a.pollOnce(), b.pollOnce()]);
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(30);
    expect(new Set(signals.map((s) => s.workflowId)).size).toBe(30);
    expect(signals).toHaveLength(30);
  });

  it('keeps per-aggregate order even when the head fails and others interleave', async () => {
    signalFailures = 1;
    const aggregate = newId();
    const other = newId();
    await seed(
      tenantA,
      'temporal.signal',
      { workflowId: 'agg-1', signal: 's' },
      { aggregateId: aggregate },
    );
    await seed(
      tenantA,
      'temporal.signal',
      { workflowId: 'agg-2', signal: 's' },
      { aggregateId: aggregate },
    );
    await seed(
      tenantA,
      'temporal.signal',
      { workflowId: 'other-1', signal: 's' },
      { aggregateId: other },
    );
    const relay = makeRelay();
    await relay.pollOnce(); // agg-1 fails, other-1 goes, agg-2 must wait
    expect(signals.map((s) => s.workflowId)).toEqual(['other-1']);
    await makeDue(tenantA);
    await relay.pollOnce(); // agg-1 now succeeds
    await relay.pollOnce(); // then agg-2
    expect(signals.map((s) => s.workflowId)).toEqual(['other-1', 'agg-1', 'agg-2']);
  });
});
