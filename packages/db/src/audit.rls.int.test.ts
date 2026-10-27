// audit_events: hash chain linkage, immutability, tenant isolation and per-tenant sequencing
// (AUDIT-002, CONTEXT_PACK §8.6, §8.8). Runs the real migrations against Postgres 16 (Testcontainers).

import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUDIT_GENESIS_PREV_HASH,
  AuditEventSchema,
  auditEventHashInput,
  type AuditEvent,
} from '@blackwing/contracts';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { migrateDatabase } from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/** Postgres error code of a rejected promise (e.g. 23001 restrict, 23514 check, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

const hex = (bytes: Buffer | null): string =>
  bytes === null ? AUDIT_GENESIS_PREV_HASH : bytes.toString('hex');

/**
 * What the AUDIT-003 helper does, in miniature: take the tenant lock through the chain head, build
 * the event on top of it, hash it with the AUDIT-001 canonical form and insert it, all in `tx`.
 */
async function appendEvent(
  tx: pg.PoolClient,
  tenantId: string,
  options: { holdMs?: number } = {},
): Promise<{ seq: number; hash: Buffer }> {
  const head = await tx.query<{ head_seq: string; head_hash: Buffer | null }>(
    'SELECT head_seq, head_hash FROM bw_audit_chain_head($1)',
    [tenantId],
  );
  const row = head.rows[0];
  if (!row) throw new Error('bw_audit_chain_head returned no row');
  if (options.holdMs) await tx.query('SELECT pg_sleep($1)', [options.holdMs / 1000]);
  const seq = Number(row.head_seq) + 1;
  const event = AuditEventSchema.parse({
    id: newId(),
    tenantId,
    occurredAt: new Date().toISOString(),
    action: 'gate2.decided',
    severity: 'notice',
    actor: { type: 'system' },
    target: { type: 'run', id: 'run-1' },
    outcome: 'success',
    metadata: { n: seq },
    prevHash: hex(row.head_hash),
    hash: 'a'.repeat(64),
    seq,
  });
  const hash = sha256(auditEventHashInput(event));
  await tx.query(
    `INSERT INTO audit_events
       (id, tenant_id, seq, occurred_at, action, severity, actor, target, outcome, metadata, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      event.id,
      tenantId,
      seq,
      event.occurredAt,
      event.action,
      event.severity,
      event.actor,
      event.target,
      event.outcome,
      event.metadata,
      row.head_hash,
      hash,
    ],
  );
  return { seq, hash };
}

interface StoredRow {
  id: string;
  seq: string;
  occurred_at: Date;
  action: string;
  severity: AuditEvent['severity'];
  actor: AuditEvent['actor'];
  target: AuditEvent['target'];
  outcome: AuditEvent['outcome'];
  metadata: AuditEvent['metadata'];
  prev_hash: Buffer | null;
  hash: Buffer;
}

/** Reads a tenant's chain and recomputes every hash; returns the sequence numbers. */
async function verifyChain(tenantId: string): Promise<number[]> {
  const rows = await db.withTenant(
    tenantId,
    async (tx) => (await tx.query<StoredRow>('SELECT * FROM audit_events ORDER BY seq')).rows,
  );
  let previous: Buffer | null = null;
  for (const row of rows) {
    expect(row.prev_hash === null ? null : row.prev_hash.toString('hex')).toBe(
      previous === null ? null : previous.toString('hex'),
    );
    const input = auditEventHashInput({
      id: row.id,
      tenantId,
      occurredAt: row.occurred_at.toISOString(),
      action: row.action,
      severity: row.severity,
      actor: row.actor,
      target: row.target,
      outcome: row.outcome,
      metadata: row.metadata,
      prevHash: hex(row.prev_hash),
      seq: Number(row.seq),
    } as AuditEvent);
    expect(row.hash.toString('hex')).toBe(sha256(input).toString('hex'));
    previous = row.hash;
  }
  return rows.map((row) => Number(row.seq));
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
});

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('audit_events hash chain', () => {
  it('chains three events: hash_n depends on hash_{n-1}', async () => {
    const hashes: Buffer[] = [];
    for (let i = 0; i < 3; i += 1) {
      hashes.push((await db.withTenant(tenantA, (tx) => appendEvent(tx, tenantA))).hash);
    }
    expect(await verifyChain(tenantA)).toEqual([1, 2, 3]);
    expect(new Set(hashes.map((h) => h.toString('hex'))).size).toBe(3);
    const rows = await db.withTenant(
      tenantA,
      async (tx) =>
        (await tx.query<StoredRow>('SELECT seq, prev_hash, hash FROM audit_events ORDER BY seq'))
          .rows,
    );
    expect(rows[0]?.prev_hash).toBeNull();
    expect(rows[1]?.prev_hash?.equals(hashes[0] ?? Buffer.alloc(0))).toBe(true);
    expect(rows[2]?.prev_hash?.equals(hashes[1] ?? Buffer.alloc(0))).toBe(true);
  });

  it('rejects a row that gaps, duplicates or forks the chain', async () => {
    const insert = (seq: number, prev: Buffer | null) =>
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO audit_events (id, tenant_id, seq, occurred_at, action, severity, actor, target, outcome, prev_hash, hash)
           VALUES ($1, $2, $3, now(), 'gate2.decided', 'notice', '{}', '{}', 'success', $4, $5)`,
          [newId(), tenantA, seq, prev, sha256(`x${String(seq)}`)],
        ),
      );
    const head = await db.withTenant(
      tenantA,
      async (tx) =>
        (
          await tx.query<{ hash: Buffer }>(
            'SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1',
          )
        ).rows[0]?.hash ?? null,
    );
    expect(await pgCode(insert(5, head))).toBe('23514'); // gap
    expect(await pgCode(insert(3, head))).toBe('23514'); // duplicate seq
    expect(await pgCode(insert(4, sha256('forged')))).toBe('23514'); // wrong prev_hash
    expect(await pgCode(insert(4, null))).toBe('23514'); // missing prev_hash
    expect(await verifyChain(tenantA)).toEqual([1, 2, 3]);
  });

  it('rejects a genesis row for a tenant that already has a chain', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO audit_events (id, tenant_id, seq, occurred_at, action, severity, actor, target, outcome, prev_hash, hash)
           VALUES ($1, $2, 1, now(), 'gate2.decided', 'notice', '{}', '{}', 'success', NULL, $3)`,
          [newId(), tenantA, sha256('genesis')],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('enforces hash length and the genesis rule with CHECK constraints', async () => {
    const owner = await db.ownerPool.connect();
    try {
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
      const bad = (seq: number, prev: Buffer | null, hash: Buffer) =>
        pgCode(
          owner.query(
            `INSERT INTO audit_events (id, tenant_id, seq, occurred_at, action, severity, actor, target, outcome, prev_hash, hash)
             VALUES ($1, $2, $3, now(), 'gate2.decided', 'notice', '{}', '{}', 'success', $4, $5)`,
            [newId(), tenantB, seq, prev, hash],
          ),
        );
      // Each failed statement aborts the transaction, so use savepoints.
      for (const attempt of [
        () => bad(1, null, Buffer.alloc(31)),
        () => bad(1, Buffer.alloc(32), Buffer.alloc(32)),
      ]) {
        await owner.query('SAVEPOINT s');
        expect(await attempt()).toBe('23514');
        await owner.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
  });
});

describe('audit_events immutability', () => {
  it('denies UPDATE, DELETE and TRUNCATE to the app role', async () => {
    const run = (sql: string) => pgCode(db.withTenant(tenantA, (tx) => tx.query(sql)));
    expect(await run("UPDATE audit_events SET reason = 'tampered'")).toBe('42501');
    expect(await run('DELETE FROM audit_events')).toBe('42501');
    expect(await run('TRUNCATE audit_events')).toBe('42501');
    expect(await verifyChain(tenantA)).toEqual([1, 2, 3]);
  });

  it('the trigger blocks the table owner too, even for statements that match no row', async () => {
    const owner = await db.ownerPool.connect();
    try {
      for (const sql of [
        "UPDATE audit_events SET reason = 'tampered'",
        'DELETE FROM audit_events',
        "DELETE FROM audit_events WHERE id = '00000000-0000-0000-0000-000000000000'",
        'TRUNCATE audit_events',
      ]) {
        await owner.query('BEGIN');
        await owner.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
        expect(await pgCode(owner.query(sql))).toBe('23001');
        await owner.query('ROLLBACK');
      }
    } finally {
      owner.release();
    }
    expect(await verifyChain(tenantA)).toEqual([1, 2, 3]);
  });

  it('grants the app role SELECT and INSERT only', async () => {
    const { rows } = await db.ownerPool.query<{ priv: string; allowed: boolean }>(
      `SELECT priv, has_table_privilege('bw_app', 'audit_events', priv) AS allowed
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS priv`,
    );
    expect(Object.fromEntries(rows.map((row) => [row.priv, row.allowed]))).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
      REFERENCES: false,
      TRIGGER: false,
    });
  });
});

describe('audit_events tenant isolation', () => {
  it('tenant B cannot read tenant A rows and has its own chain', async () => {
    await db.withTenant(tenantB, (tx) => appendEvent(tx, tenantB));
    const own = await db.withTenant(
      tenantB,
      async (tx) =>
        (await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM audit_events')).rows,
    );
    expect(own).toEqual([{ tenant_id: tenantB }]);
    expect(await verifyChain(tenantB)).toEqual([1]);
    expect(await verifyChain(tenantA)).toEqual([1, 2, 3]);
  });

  it('fails closed without a tenant context', async () => {
    const code = await pgCode(db.appPool.query('SELECT * FROM audit_events'));
    // 42704: setting never defined on the connection; 22P02: reset to '' by an earlier transaction.
    expect(['42704', '22P02']).toContain(code);
  });

  it('rejects a row for another tenant than the session tenant', async () => {
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO audit_events (id, tenant_id, seq, occurred_at, action, severity, actor, target, outcome, prev_hash, hash)
           VALUES ($1, $2, 4, now(), 'gate2.decided', 'notice', '{}', '{}', 'success', $3, $4)`,
          [newId(), tenantA, sha256('x'), sha256('y')],
        ),
      ),
    );
    expect(code).toBe('42501');
    expect(await verifyChain(tenantA)).toEqual([1, 2, 3]);
  });

  it('refuses the chain head (and its lock) of another tenant', async () => {
    const code = await pgCode(
      db.withTenant(tenantB, (tx) => tx.query('SELECT * FROM bw_audit_chain_head($1)', [tenantA])),
    );
    expect(code).toBe('42501');
  });
});

describe('audit_events concurrent sequencing', () => {
  it('gives concurrent inserts for one tenant distinct, gapless seq and a valid chain', async () => {
    const tenant = newId();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        db.withTenant(tenant, (tx) => appendEvent(tx, tenant, { holdMs: 20 })),
      ),
    );
    expect(results.map((r) => r.seq).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await verifyChain(tenant)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps chains of different tenants independent and uncontended', async () => {
    const tenants = [newId(), newId(), newId()];
    const started = Date.now();
    await Promise.all(
      tenants.flatMap((tenant) =>
        Array.from({ length: 3 }, () =>
          db.withTenant(tenant, (tx) => appendEvent(tx, tenant, { holdMs: 100 })),
        ),
      ),
    );
    for (const tenant of tenants) expect(await verifyChain(tenant)).toEqual([1, 2, 3]);
    // Each tenant serialises its own 3 x 100 ms; tenants overlap, so the total stays well below the
    // 900 ms a single shared lock would need.
    expect(Date.now() - started).toBeLessThan(850);
  });
});
