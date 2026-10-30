// Encrypted per-role session store (SESSION-004): tenant isolation, fail-closed without a tenant context, the
// status, kind, role-name and size CHECKs, composite foreign keys, the runtime role's no-delete grant, and the
// repository's upsert, find and scrub rules, against the real migrations on Postgres 16 (Testcontainers).
// Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotFoundError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import { roleSessionRepository, type RoleSessionWrite } from './role-sessions.repository.js';
import { type TenantTx, withTenant } from './with-tenant.js';

import type { StoredSessionKey } from '@blackwing/contracts';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** Postgres error code of a rejected promise (23514 check, 23503 foreign key, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

const database = () => createDatabase(db.appPool);
const inTenant = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) =>
  withTenant(database(), tenantId, fn);

/** A run and an asset in one tenant (the session's composite foreign keys need them). */
async function seedScope(tenantId: string): Promise<{ runId: string; assetId: string }> {
  const runId = newId();
  const assetId = newId();
  const userId = newId();
  await db.withTenant(tenantId, async (tx) => {
    await tx.query(`INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)`, [
      userId,
      `session-${userId}`,
      `session-${userId}@example.test`,
    ]);
    await tx.query('INSERT INTO runs (id, tenant_id) VALUES ($1, $2)', [runId, tenantId]);
    await tx.query(
      `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id, verification_status)
       VALUES ($1, $2, $3, 'web_app', 'session asset', $4::jsonb, 'dev', $5, 'unverified')`,
      [
        assetId,
        tenantId,
        `asset_${assetId.replaceAll('-', '')}`,
        JSON.stringify([{ kind: 'url', value: 'https://session.example.test' }]),
        userId,
      ],
    );
  });
  return { runId, assetId };
}

function keyFor(
  tenantId: string,
  runId: string,
  assetId: string,
  roleName = 'admin',
): StoredSessionKey {
  return { tenantId, runId, assetId, roleName };
}

function writeFor(
  key: StoredSessionKey,
  overrides: Partial<RoleSessionWrite> = {},
): RoleSessionWrite {
  const now = new Date();
  return {
    id: newId(),
    key,
    kind: 'cookie',
    encMaterial: Buffer.from('{"v":1,"ct":"AAAA"}', 'utf8'),
    encKeyRef: `tenant-${key.tenantId}@v1`,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    now,
    ...overrides,
  };
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('migration and schema', () => {
  it('creates role_sessions with forced RLS and the tenant policy', async () => {
    const rls = await db.withTenant(tenantA, (tx) =>
      tx.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'role_sessions'`,
      ),
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('carries the scope uniqueness and the status, kind, role-name and size CHECKs', async () => {
    const constraints = await db.withTenant(tenantA, (tx) =>
      tx.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'role_sessions'::regclass`,
      ),
    );
    expect(constraints.rows.map((r) => r.conname)).toEqual(
      expect.arrayContaining([
        'role_sessions_scope_key',
        'role_sessions_status_check',
        'role_sessions_kind_check',
        'role_sessions_role_name_check',
        'role_sessions_material_max_check',
        'role_sessions_material_check',
      ]),
    );
  });
});

describe('upsert and find', () => {
  it('stores a session and reads it back in its own tenant, with no plaintext column', async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const key = keyFor(tenantA, runId, assetId);
    const write = writeFor(key);
    const row = await inTenant(tenantA, (tx) => roleSessionRepository.upsert(tx, write));
    expect(row).toMatchObject({
      id: write.id,
      status: 'active',
      kind: 'cookie',
      roleName: 'admin',
    });
    const found = await inTenant(tenantA, (tx) => roleSessionRepository.getByScope(tx, key));
    expect(found?.id).toBe(write.id);
    expect(found?.encMaterial.toString('utf8')).toBe('{"v":1,"ct":"AAAA"}');
  });

  it('replaces the row of the same scope in one statement (last writer wins, one row)', async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const key = keyFor(tenantA, runId, assetId);
    const first = writeFor(key);
    const second = writeFor(key, { kind: 'bearer', encKeyRef: 'tenant-x@v2' });
    await inTenant(tenantA, (tx) => roleSessionRepository.upsert(tx, first));
    await inTenant(tenantA, (tx) => roleSessionRepository.upsert(tx, second));
    const count = await db.withTenant(tenantA, (tx) =>
      tx.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM role_sessions WHERE run_id = $1 AND asset_id = $2',
        [runId, assetId],
      ),
    );
    expect(count.rows[0]?.n).toBe('1');
    const found = await inTenant(tenantA, (tx) => roleSessionRepository.getByScope(tx, key));
    expect(found).toMatchObject({ id: second.id, kind: 'bearer', encKeyRef: 'tenant-x@v2' });
  });

  it('keeps distinct roles of one run and asset apart', async () => {
    const { runId, assetId } = await seedScope(tenantA);
    await inTenant(tenantA, (tx) =>
      roleSessionRepository.upsert(tx, writeFor(keyFor(tenantA, runId, assetId, 'admin'))),
    );
    await inTenant(tenantA, (tx) =>
      roleSessionRepository.upsert(tx, writeFor(keyFor(tenantA, runId, assetId, 'viewer'))),
    );
    const viewer = await inTenant(tenantA, (tx) =>
      roleSessionRepository.getByScope(tx, keyFor(tenantA, runId, assetId, 'viewer')),
    );
    expect(viewer?.roleName).toBe('viewer');
  });

  it('returns null for a scope that does not exist', async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const found = await inTenant(tenantA, (tx) =>
      roleSessionRepository.getByScope(tx, keyFor(tenantA, runId, assetId, 'nobody')),
    );
    expect(found).toBeNull();
  });
});

describe('tenant isolation (RLS)', () => {
  it("tenant B cannot find tenant A's session", async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const key = keyFor(tenantA, runId, assetId);
    await inTenant(tenantA, (tx) => roleSessionRepository.upsert(tx, writeFor(key)));
    const seen = await inTenant(tenantB, (tx) => roleSessionRepository.getByScope(tx, key));
    expect(seen).toBeNull();
  });

  it("tenant B cannot revoke tenant A's session (zero rows changed, material untouched)", async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const key = keyFor(tenantA, runId, assetId);
    await inTenant(tenantA, (tx) => roleSessionRepository.upsert(tx, writeFor(key)));
    const changed = await inTenant(tenantB, (tx) =>
      roleSessionRepository.setStatus(tx, key, 'revoked', new Date()),
    );
    expect(changed).toBe(false);
    const still = await inTenant(tenantA, (tx) => roleSessionRepository.getByScope(tx, key));
    expect(still).toMatchObject({ status: 'active' });
    expect(still?.encMaterial.length).toBeGreaterThan(0);
  });

  it("tenant B cannot store a session naming tenant A's run or asset (composite foreign keys)", async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const crossKey = keyFor(tenantB, runId, assetId);
    await expect(
      inTenant(tenantB, (tx) => roleSessionRepository.upsert(tx, writeFor(crossKey))),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a write that names another tenant than the transaction (RLS WITH CHECK)', async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const key = keyFor(tenantA, runId, assetId);
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO role_sessions (id, tenant_id, run_id, asset_id, role_name, kind, enc_material, enc_key_ref, expires_at)
           VALUES ($1, $2, $3, $4, 'x', 'cookie', '\\x00', 'k', now() + interval '1 hour')`,
          [newId(), key.tenantId, runId, assetId],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('a raw read with no tenant context fails closed', async () => {
    const code = await pgCode(
      db.appPool.query('SELECT count(*) FROM role_sessions').then(() => undefined),
    );
    // Fails closed: an unset or emptied `app.tenant_id` never matches a row (42704 unset, 22P02 emptied).
    expect(code).toMatch(/^(42704|22P02)$/);
  });
});

describe('revoke and scrub', () => {
  it('setStatus revoked scrubs the material in the same statement and reports the change once', async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const key = keyFor(tenantA, runId, assetId);
    await inTenant(tenantA, (tx) => roleSessionRepository.upsert(tx, writeFor(key)));
    const now = new Date();
    expect(
      await inTenant(tenantA, (tx) => roleSessionRepository.setStatus(tx, key, 'revoked', now)),
    ).toBe(true);
    expect(
      await inTenant(tenantA, (tx) => roleSessionRepository.setStatus(tx, key, 'revoked', now)),
    ).toBe(false);
    const row = await inTenant(tenantA, (tx) => roleSessionRepository.getByScope(tx, key));
    expect(row).toMatchObject({ status: 'revoked', encKeyRef: '' });
    expect(row?.encMaterial.length).toBe(0);
  });

  it('refuses an active session with its material removed (material CHECK, 23514)', async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO role_sessions (id, tenant_id, run_id, asset_id, role_name, kind, enc_material, enc_key_ref, expires_at)
           VALUES ($1, $2, $3, $4, 'empty', 'cookie', '\\x', 'k', now() + interval '1 hour')`,
          [newId(), tenantA, runId, assetId],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('the runtime role cannot delete a session row (no DELETE grant)', async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const key = keyFor(tenantA, runId, assetId);
    await inTenant(tenantA, (tx) => roleSessionRepository.upsert(tx, writeFor(key)));
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM role_sessions WHERE run_id = $1', [runId]),
      ),
    );
    expect(code).toBe('42501');
  });
});

describe('database constraints', () => {
  it('rejects an unknown status, an unknown kind and a malformed role name (CHECK, 23514)', async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const insert = (status: string, kind: string, role: string) =>
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO role_sessions (id, tenant_id, run_id, asset_id, role_name, kind, enc_material, enc_key_ref, expires_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, '\\x00', 'k', now() + interval '1 hour', $7)`,
          [newId(), tenantA, runId, assetId, role, kind, status],
        ),
      );
    expect(await pgCode(insert('live', 'cookie', 'ok'))).toBe('23514');
    expect(await pgCode(insert('active', 'password', 'ok'))).toBe('23514');
    expect(await pgCode(insert('active', 'cookie', 'role:colon'))).toBe('23514');
  });

  it('rejects material above the 128 KiB envelope cap (CHECK, 23514)', async () => {
    const { runId, assetId } = await seedScope(tenantA);
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO role_sessions (id, tenant_id, run_id, asset_id, role_name, kind, enc_material, enc_key_ref, expires_at)
           VALUES ($1, $2, $3, $4, 'big', 'cookie', decode(repeat('00', 131073), 'hex'), 'k', now() + interval '1 hour')`,
          [newId(), tenantA, runId, assetId],
        ),
      ),
    );
    expect(code).toBe('23514');
  });
});
