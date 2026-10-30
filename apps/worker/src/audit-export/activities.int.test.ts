// The SIEM export activity against the real migrations (Testcontainers, Postgres 16): ledger events are appended through
// the audit emitter, a subscription delivers them in seq order, a failed delivery leaves the cursor, the cursor only
// moves on confirmation, the credential is resolved by reference, and tenant B can neither see nor move tenant A's
// subscription.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAuditEmitter,
  type AuditExportMetrics,
  type SiemConnector,
  type SiemDeliveryResult,
  type SiemTarget,
} from '@blackwing/audit';
import {
  createDatabase,
  type Database,
  migrateDatabase,
  toAuditSqlTx,
  withTenant,
} from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createAuditExportActivities } from './activities.js';

import type { AuditEvent } from '@blackwing/contracts';

let pg: PostgresHandle;
let db: Database;

const tenantA = newId();
const tenantB = newId();
const SECRET_VALUE = 'hec-token-live-value-9f2';
const emitter = createAuditEmitter();

const metrics: AuditExportMetrics = {
  delivered: () => undefined,
  failed: () => undefined,
  backlog: () => undefined,
  cursor: () => undefined,
};

const log = { info: () => undefined, warn: () => undefined };

/** A destination that records what it got and can be told to fail. */
class RecordingConnector implements SiemConnector<{ host: string }> {
  readonly kind = 'splunk_hec' as const;
  readonly maxBatchSize = 2;
  readonly delivered: AuditEvent[] = [];
  readonly secrets: string[] = [];
  failNext = false;

  validate(config: unknown): { host: string } {
    const host = (config as { host?: unknown }).host;
    if (typeof host !== 'string') throw new Error('host required');
    return { host };
  }

  testConnection(): Promise<void> {
    return Promise.resolve();
  }

  deliver(
    batch: readonly AuditEvent[],
    target: SiemTarget<{ host: string }>,
  ): Promise<SiemDeliveryResult> {
    this.secrets.push(target.secret);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('destination unreachable'));
    }
    this.delivered.push(...batch);
    return Promise.resolve({ deliveredThrough: batch.at(-1)?.seq ?? 0 });
  }
}

async function appendEvents(tenantId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await withTenant(db, tenantId, (tx) =>
      emitter.emitAuditInTx(toAuditSqlTx(tx), {
        tenantId,
        action: 'gate2.decided',
        actor: { type: 'system', id: 'test' },
        target: { type: 'run', id: newId() },
        outcome: 'success',
        metadata: { i },
      }),
    );
  }
}

async function insertSubscription(
  tenantId: string,
  options: { cursor?: number; filters?: string } = {},
): Promise<string> {
  const id = newId();
  await pg.withTenant(tenantId, (tx) =>
    tx.query(
      `INSERT INTO audit_export_subscriptions (id, tenant_id, kind, config, secret_ref, cursor_seq, filters)
       VALUES ($1, $2, 'splunk_hec', '{"host":"siem.example.test"}', $3, $4, $5::jsonb)`,
      [
        id,
        tenantId,
        `bw-secret://${tenantId}/${newId()}`,
        options.cursor ?? 0,
        options.filters ?? '{}',
      ],
    ),
  );
  return id;
}

async function cursorOf(tenantId: string, id: string): Promise<number> {
  const { rows } = await pg.withTenant(tenantId, (tx) =>
    tx.query<{ cursor_seq: string }>(
      'SELECT cursor_seq FROM audit_export_subscriptions WHERE id = $1',
      [id],
    ),
  );
  return Number(rows[0]?.cursor_seq);
}

beforeAll(async () => {
  pg = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  db = createDatabase(pg.appPool);
}, 180_000);

afterAll(async () => {
  await pg.stop();
});

function activities(connector: SiemConnector, resolved: string[], batchSize = 10) {
  return createAuditExportActivities({
    db,
    connectors: new Map([['splunk_hec', connector]]),
    resolveSecret: (tenantId, ref) => {
      expect(ref).toMatch(new RegExp(`^bw-secret://${tenantId}/`));
      resolved.push(ref);
      return Promise.resolve(SECRET_VALUE);
    },
    batchSize,
    metrics,
    log,
  });
}

describe('SIEM export activity (AUDIT-004)', () => {
  it('delivers new ledger events in seq order and advances the cursor only on confirmation', async () => {
    await appendEvents(tenantA, 3);
    const sub = await insertSubscription(tenantA);
    const connector = new RecordingConnector();
    const resolved: string[] = [];

    const result = await activities(connector, resolved).exportAuditBatchActivity({
      tenantId: tenantA,
      subscriptionId: sub,
    });
    expect(result).toMatchObject({ status: 'delivered', cursorSeq: 3, delivered: 3 });
    expect(connector.delivered.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await cursorOf(tenantA, sub)).toBe(3);
    expect(resolved).toHaveLength(1);
  });

  it('resumes after the cursor with no gap and no re-send once the window is confirmed', async () => {
    const sub = await insertSubscription(tenantA, { cursor: 3 });
    await appendEvents(tenantA, 2);
    const connector = new RecordingConnector();

    const result = await activities(connector, []).exportAuditBatchActivity({
      tenantId: tenantA,
      subscriptionId: sub,
    });
    expect(result).toMatchObject({ status: 'delivered', cursorSeq: 5, delivered: 2 });
    expect(connector.delivered.map((e) => e.seq)).toEqual([4, 5]);

    const again = await activities(connector, []).exportAuditBatchActivity({
      tenantId: tenantA,
      subscriptionId: sub,
    });
    expect(again).toMatchObject({ status: 'idle', cursorSeq: 5 });
    expect(connector.delivered).toHaveLength(2);
  });

  it('a failed delivery leaves the cursor unchanged and the next run sends the same window', async () => {
    const sub = await insertSubscription(tenantA, { cursor: 5 });
    await appendEvents(tenantA, 2);
    const connector = new RecordingConnector();
    connector.failNext = true;

    const failed = await activities(connector, []).exportAuditBatchActivity({
      tenantId: tenantA,
      subscriptionId: sub,
    });
    expect(failed).toMatchObject({ status: 'failed', cursorSeq: 5, reason: 'Error' });
    expect(await cursorOf(tenantA, sub)).toBe(5);

    // The failure itself is a ledger event (export.generated, failure) and is exported after the window it failed on.
    const retried = await activities(connector, []).exportAuditBatchActivity({
      tenantId: tenantA,
      subscriptionId: sub,
    });
    expect(retried).toMatchObject({ status: 'delivered', cursorSeq: 8 });
    expect(connector.delivered.map((e) => e.seq)).toEqual([6, 7, 8]);
    expect(connector.delivered.at(-1)).toMatchObject({
      action: 'export.generated',
      outcome: 'failure',
    });
  });

  it('applies the action filter and still moves the cursor past the filtered events', async () => {
    const sub = await insertSubscription(tenantA, {
      cursor: 7,
      filters: '{"actions":["kill.triggered"]}',
    });
    await withTenant(db, tenantA, (tx) =>
      emitter.emitAuditInTx(toAuditSqlTx(tx), {
        tenantId: tenantA,
        action: 'kill.triggered',
        actor: { type: 'system', id: 'test' },
        target: { type: 'run', id: newId() },
        outcome: 'success',
      }),
    );
    await appendEvents(tenantA, 1);
    const connector = new RecordingConnector();
    const result = await activities(connector, []).exportAuditBatchActivity({
      tenantId: tenantA,
      subscriptionId: sub,
    });
    expect(result).toMatchObject({ status: 'delivered', cursorSeq: 10, delivered: 1 });
    expect(connector.delivered.map((e) => e.action)).toEqual(['kill.triggered']);
  });

  it("tenant B cannot see or move tenant A's subscription, and tenant A's events never reach B", async () => {
    const sub = await insertSubscription(tenantA);
    await appendEvents(tenantB, 1);
    const connector = new RecordingConnector();
    expect(
      await activities(connector, []).exportAuditBatchActivity({
        tenantId: tenantB,
        subscriptionId: sub,
      }),
    ).toEqual({ status: 'not_found' });
    expect(await cursorOf(tenantA, sub)).toBe(0);
    expect(connector.delivered).toHaveLength(0);

    const own = await insertSubscription(tenantB);
    await activities(connector, []).exportAuditBatchActivity({
      tenantId: tenantB,
      subscriptionId: own,
    });
    expect(connector.delivered.every((e) => e.tenantId === tenantB)).toBe(true);
  });

  it('a paused subscription stops at its cursor and sends nothing', async () => {
    const sub = await insertSubscription(tenantA, { cursor: 0 });
    await pg.withTenant(tenantA, (tx) =>
      tx.query("UPDATE audit_export_subscriptions SET status = 'paused' WHERE id = $1", [sub]),
    );
    const connector = new RecordingConnector();
    const result = await activities(connector, []).exportAuditBatchActivity({
      tenantId: tenantA,
      subscriptionId: sub,
    });
    expect(result).toMatchObject({ status: 'skipped', reason: 'paused', cursorSeq: 0 });
    expect(connector.delivered).toHaveLength(0);
  });

  it('never stores the credential: neither the config nor the subscription row holds the value', async () => {
    const sub = await insertSubscription(tenantA, { cursor: 9 });
    await appendEvents(tenantA, 1);
    await activities(new RecordingConnector(), []).exportAuditBatchActivity({
      tenantId: tenantA,
      subscriptionId: sub,
    });
    const { rows } = await pg.withTenant(tenantA, (tx) =>
      tx.query<{ row: string }>(
        'SELECT row_to_json(s)::text AS row FROM audit_export_subscriptions s WHERE id = $1',
        [sub],
      ),
    );
    expect(rows[0]?.row).not.toContain(SECRET_VALUE);
    const ledger = await pg.withTenant(tenantA, (tx) =>
      tx.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM audit_events WHERE metadata::text LIKE $1',
        [`%${SECRET_VALUE}%`],
      ),
    );
    expect(ledger.rows[0]?.n).toBe('0');
  });

  it('a subscription whose config is refused is disabled and audited, not retried', async () => {
    const id = newId();
    await pg.withTenant(tenantA, (tx) =>
      tx.query(
        `INSERT INTO audit_export_subscriptions (id, tenant_id, kind, config, secret_ref)
         VALUES ($1, $2, 'splunk_hec', '{"port":1}', $3)`,
        [id, tenantA, `bw-secret://${tenantA}/${newId()}`],
      ),
    );
    await appendEvents(tenantA, 1);
    const result = await activities(new RecordingConnector(), []).exportAuditBatchActivity({
      tenantId: tenantA,
      subscriptionId: id,
    });
    expect(result).toMatchObject({ status: 'skipped', reason: 'disabled' });
    const { rows } = await pg.withTenant(tenantA, (tx) =>
      tx.query<{ status: string }>('SELECT status FROM audit_export_subscriptions WHERE id = $1', [
        id,
      ]),
    );
    expect(rows[0]?.status).toBe('error');
    const audited = await pg.withTenant(tenantA, (tx) =>
      tx.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_events WHERE action = 'connector.configured' AND target->>'id' = $1",
        [id],
      ),
    );
    expect(audited.rows[0]?.n).toBe('1');
  });
});
