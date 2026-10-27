// secrets / secret_versions: round trip, tenant RLS, unique names, the CHECK constraints and the
// grants, against the real migrations on Postgres 16 (Testcontainers).

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { migrateDatabase } from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const envelope = JSON.stringify({ v: 1, ciphertext: 'AAAA' });

/** Postgres error code of a rejected promise (23505 unique, 23514 check, 23503 FK, 42501 RLS / privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      if (cause instanceof pg.DatabaseError) return cause.code;
    }
    return 'not-a-database-error';
  }
  return undefined;
}

/** Inserts a secret as the app role; extra columns override the valid defaults. */
function insertSecret(tenantId: string, columns: Record<string, string | null> = {}) {
  const row: Record<string, string | null> = {
    id: newId(),
    tenant_id: tenantId,
    name: `secret-${newId()}`,
    envelope,
    ...columns,
  };
  const names = Object.keys(row);
  return db.withTenant(tenantId, (tx) =>
    tx.query(
      `INSERT INTO secrets (${names.join(', ')}) VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(', ')}) RETURNING *`,
      Object.values(row),
    ),
  );
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
});

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('secrets: round trip', () => {
  it('stores a secret with its defaults and a version, and reads both back', async () => {
    const created = await insertSecret(tenantA, { name: 'round-trip', type: 'api_key' });
    const secret = created.rows[0] as Record<string, unknown>;
    expect(secret).toMatchObject({
      tenant_id: tenantA,
      name: 'round-trip',
      type: 'api_key',
      backend: 'openbao',
      current_version: 1,
      status: 'active',
      external_locator: null,
    });
    await db.withTenant(tenantA, (tx) =>
      tx.query(
        'INSERT INTO secret_versions (tenant_id, secret_id, version, envelope) VALUES ($1, $2, 1, $3)',
        [tenantA, secret.id, envelope],
      ),
    );
    const { rows } = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT version, envelope, retired_at FROM secret_versions WHERE secret_id = $1', [
        secret.id,
      ]),
    );
    expect(rows).toEqual([
      { version: 1, envelope: { v: 1, ciphertext: 'AAAA' }, retired_at: null },
    ]);
  });

  it('bumps updated_at on update', async () => {
    const { rows } = await insertSecret(tenantA);
    const row = rows[0] as { id: string; updated_at: Date };
    await db.withTenant(tenantA, async (tx) => {
      // Two statements: the extended protocol (bind parameters) takes one command per query.
      await tx.query('SELECT pg_sleep(0.01)');
      await tx.query(`UPDATE secrets SET status = 'rotating' WHERE id = $1`, [row.id]);
    });
    const after = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT updated_at FROM secrets WHERE id = $1', [row.id]),
    );
    expect((after.rows[0] as { updated_at: Date }).updated_at.getTime()).toBeGreaterThan(
      row.updated_at.getTime(),
    );
  });
});

describe('secrets: tenant isolation', () => {
  it('RLS hides another tenant secrets and versions', async () => {
    const { rows } = await insertSecret(tenantA, { name: 'only-a' });
    const id = (rows[0] as { id: string }).id;
    await db.withTenant(tenantA, (tx) =>
      tx.query('INSERT INTO secret_versions (tenant_id, secret_id, version) VALUES ($1, $2, 1)', [
        tenantA,
        id,
      ]),
    );
    const seenByB = await db.withTenant(tenantB, async (tx) => ({
      secrets: (await tx.query('SELECT 1 FROM secrets WHERE id = $1', [id])).rowCount,
      versions: (await tx.query('SELECT 1 FROM secret_versions WHERE secret_id = $1', [id]))
        .rowCount,
    }));
    expect(seenByB).toEqual({ secrets: 0, versions: 0 });
  });

  it('refuses a version for a secret of another tenant (composite FK) and a foreign-tenant insert (RLS)', async () => {
    const { rows } = await insertSecret(tenantA);
    const id = (rows[0] as { id: string }).id;
    expect(
      await pgCode(
        db.withTenant(tenantB, (tx) =>
          tx.query(
            'INSERT INTO secret_versions (tenant_id, secret_id, version) VALUES ($1, $2, 1)',
            [tenantB, id],
          ),
        ),
      ),
    ).toBe('23503');
    expect(
      await pgCode(
        db.withTenant(tenantB, (tx) =>
          tx.query(
            'INSERT INTO secret_versions (tenant_id, secret_id, version) VALUES ($1, $2, 1)',
            [tenantA, id],
          ),
        ),
      ),
    ).toBe('42501');
  });
});

describe('secrets: constraints', () => {
  it('enforces unique (tenant_id, name) per tenant, not across tenants', async () => {
    await insertSecret(tenantA, { name: 'dup' });
    expect(await pgCode(insertSecret(tenantA, { name: 'dup' }))).toBe('23505');
    await expect(insertSecret(tenantB, { name: 'dup' })).resolves.toBeDefined();
  });

  it('rejects a name that is not NFC or has control characters', async () => {
    expect(await pgCode(insertSecret(tenantA, { name: 'café' }))).toBe('23514');
    expect(await pgCode(insertSecret(tenantA, { name: 'a\u0007b' }))).toBe('23514');
    expect(await pgCode(insertSecret(tenantA, { name: '' }))).toBe('23514');
    await expect(insertSecret(tenantA, { name: 'café' })).resolves.toBeDefined();
  });

  it('rejects unknown type, backend and status values', async () => {
    expect(await pgCode(insertSecret(tenantA, { type: 'plain' }))).toBe('23514');
    expect(await pgCode(insertSecret(tenantA, { backend: 'file' }))).toBe('23514');
    expect(await pgCode(insertSecret(tenantA, { status: 'deleted' }))).toBe('23514');
  });

  it('requires an external_locator for an external backend', async () => {
    expect(await pgCode(insertSecret(tenantA, { backend: 'aws_kms', envelope: null }))).toBe(
      '23514',
    );
    await expect(
      insertSecret(tenantA, {
        backend: 'aws_secrets_manager',
        envelope: null,
        external_locator: JSON.stringify({ arn: 'arn:aws:secretsmanager:eu-west-1:1:secret:x' }),
      }),
    ).resolves.toBeDefined();
  });

  it('requires a value (envelope or locator) unless the secret is shredded', async () => {
    expect(await pgCode(insertSecret(tenantA, { envelope: null }))).toBe('23514');
    await expect(
      insertSecret(tenantA, { envelope: null, status: 'shredded' }),
    ).resolves.toBeDefined();
  });

  it('rejects non-object JSON and plaintext-looking keys in envelope and locator', async () => {
    expect(await pgCode(insertSecret(tenantA, { envelope: JSON.stringify('hunter2') }))).toBe(
      '23514',
    );
    expect(
      await pgCode(insertSecret(tenantA, { envelope: JSON.stringify({ plaintext: 'hunter2' }) })),
    ).toBe('23514');
    expect(
      await pgCode(
        insertSecret(tenantA, {
          backend: 'vault',
          external_locator: JSON.stringify({ password: 'x' }),
        }),
      ),
    ).toBe('23514');
  });

  it('rejects current_version below 1 and a version row below 1 or retired before created', async () => {
    expect(await pgCode(insertSecret(tenantA, { current_version: '0' }))).toBe('23514');
    const { rows } = await insertSecret(tenantA);
    const id = (rows[0] as { id: string }).id;
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            'INSERT INTO secret_versions (tenant_id, secret_id, version) VALUES ($1, $2, 0)',
            [tenantA, id],
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO secret_versions (tenant_id, secret_id, version, retired_at) VALUES ($1, $2, 1, now() - interval '1 day')`,
            [tenantA, id],
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('keeps one row per (secret_id, version)', async () => {
    const { rows } = await insertSecret(tenantA);
    const id = (rows[0] as { id: string }).id;
    const add = () =>
      db.withTenant(tenantA, (tx) =>
        tx.query('INSERT INTO secret_versions (tenant_id, secret_id, version) VALUES ($1, $2, 2)', [
          tenantA,
          id,
        ]),
      );
    await add();
    expect(await pgCode(add())).toBe('23505');
  });
});

describe('secrets: grants', () => {
  it('bw_app cannot DELETE secrets or versions (shred instead)', async () => {
    expect(await pgCode(db.withTenant(tenantA, (tx) => tx.query('DELETE FROM secrets')))).toBe(
      '42501',
    );
    expect(
      await pgCode(db.withTenant(tenantA, (tx) => tx.query('DELETE FROM secret_versions'))),
    ).toBe('42501');
  });
});
