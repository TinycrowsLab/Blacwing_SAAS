// audit-export.rls: tenant isolation, constraints and the forward-only cursor of SIEM export subscriptions
// (AUDIT-004, CONTEXT_PACK §7, §8.6, §8.8). Runs the real migrations against Postgres 16 (Testcontainers).

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { migrateDatabase } from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** Postgres error code of a rejected promise (23514 check, 42501 RLS, 23xxx ...). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

const secretRef = (tenantId: string): string => `bw-secret://${tenantId}/${newId()}`;

async function insertSubscription(
  tx: pg.PoolClient,
  tenantId: string,
  options: { kind?: string; status?: string; secretRef?: string; config?: string } = {},
): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO audit_export_subscriptions (id, tenant_id, kind, status, secret_ref, config)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      id,
      tenantId,
      options.kind ?? 'splunk_hec',
      options.status ?? 'active',
      options.secretRef ?? secretRef(tenantId),
      options.config ?? '{"host":"siem.example.test"}',
    ],
  );
  return id;
}

const subs = { a: '', b: '' };

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  subs.a = await db.withTenant(tenantA, (tx) => insertSubscription(tx, tenantA));
  subs.b = await db.withTenant(tenantB, (tx) => insertSubscription(tx, tenantB));
});

afterAll(async () => {
  await db.stop();
});

describe('audit_export_subscriptions tenant isolation', () => {
  it('a tenant sees only its own subscriptions', async () => {
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.query<{ id: string }>('SELECT id FROM audit_export_subscriptions'),
    );
    expect(rows.rows.map((r) => r.id)).toEqual([subs.a]);
  });

  it('a tenant cannot read, update or delete another tenant row', async () => {
    const seen = await db.withTenant(tenantB, (tx) =>
      tx.query('SELECT id FROM audit_export_subscriptions WHERE id = $1', [subs.a]),
    );
    expect(seen.rows).toHaveLength(0);
    const updated = await db.withTenant(tenantB, (tx) =>
      tx.query("UPDATE audit_export_subscriptions SET status = 'paused' WHERE id = $1", [subs.a]),
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await db.withTenant(tenantB, (tx) =>
      tx.query('DELETE FROM audit_export_subscriptions WHERE id = $1', [subs.a]),
    );
    expect(deleted.rowCount).toBe(0);
  });

  it('a tenant cannot insert a row for another tenant', async () => {
    expect(await pgCode(db.withTenant(tenantB, (tx) => insertSubscription(tx, tenantA)))).toBe(
      '42501',
    );
  });

  it('fails closed without a tenant context', async () => {
    await expect(db.appPool.query('SELECT id FROM audit_export_subscriptions')).rejects.toThrow();
  });
});

describe('audit_export_subscriptions constraints', () => {
  it('rejects an unknown kind, an unknown status and a negative cursor', async () => {
    await expect(
      pgCode(db.withTenant(tenantA, (tx) => insertSubscription(tx, tenantA, { kind: 'ftp' }))),
    ).resolves.toBe('23514');
    await expect(
      pgCode(
        db.withTenant(tenantA, (tx) => insertSubscription(tx, tenantA, { status: 'deleted' })),
      ),
    ).resolves.toBe('23514');
    await expect(
      pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO audit_export_subscriptions (id, tenant_id, kind, secret_ref, cursor_seq)
             VALUES ($1, $2, 'splunk_hec', $3, -1)`,
            [newId(), tenantA, secretRef(tenantA)],
          ),
        ),
      ),
    ).resolves.toBe('23514');
  });

  it('refuses a plaintext value where a secret_ref belongs', async () => {
    await expect(
      pgCode(
        db.withTenant(tenantA, (tx) =>
          insertSubscription(tx, tenantA, { secretRef: 'hunter2-plaintext' }),
        ),
      ),
    ).resolves.toBe('23514');
    await expect(
      pgCode(
        db.withTenant(tenantA, (tx) =>
          insertSubscription(tx, tenantA, { secretRef: `bw-secret://${tenantA}/x y` }),
        ),
      ),
    ).resolves.toBe('23514');
  });

  it('requires config and filters to be JSON objects', async () => {
    await expect(
      pgCode(db.withTenant(tenantA, (tx) => insertSubscription(tx, tenantA, { config: '["a"]' }))),
    ).resolves.toBe('23514');
  });
});

describe('audit_export_subscriptions cursor', () => {
  it('moves forward and refuses a rewind, whichever writer tries it', async () => {
    await db.withTenant(tenantA, (tx) =>
      tx.query('UPDATE audit_export_subscriptions SET cursor_seq = 10 WHERE id = $1', [subs.a]),
    );
    await expect(
      pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query('UPDATE audit_export_subscriptions SET cursor_seq = 9 WHERE id = $1', [subs.a]),
        ),
      ),
    ).resolves.toBe('23514');
    const row = await db.withTenant(tenantA, (tx) =>
      tx.query<{ cursor_seq: string }>(
        'SELECT cursor_seq FROM audit_export_subscriptions WHERE id = $1',
        [subs.a],
      ),
    );
    expect(Number(row.rows[0]?.cursor_seq)).toBe(10);
  });

  it('keeps updated_at in step with changes', async () => {
    const before = await db.withTenant(tenantB, (tx) =>
      tx.query<{ updated_at: Date }>(
        'SELECT updated_at FROM audit_export_subscriptions WHERE id = $1',
        [subs.b],
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await db.withTenant(tenantB, (tx) =>
      tx.query("UPDATE audit_export_subscriptions SET status = 'paused' WHERE id = $1", [subs.b]),
    );
    const after = await db.withTenant(tenantB, (tx) =>
      tx.query<{ updated_at: Date }>(
        'SELECT updated_at FROM audit_export_subscriptions WHERE id = $1',
        [subs.b],
      ),
    );
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]?.updated_at.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });
});
