// Virtual model keys (GATEWAY-002, #405): tenant isolation, the hash-gated resolve, revoke-by-run, the runtime
// role's privileges, the CHECK constraints and the audit write in the same transaction, against the real
// migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateVirtualKey, hashVirtualKey, virtualKeyLookupPrefix } from '@blackwing/crypto';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import {
  createPgVirtualKeyStore,
  createVirtualKeyAuthenticator,
  type NewVirtualKey,
} from './virtual-keys.repository.js';
import { withTenant } from './with-tenant.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const runA = newId();
const sessionA = newId();
const FUTURE = new Date(Date.now() + 3_600_000);
const noAudit = (): Promise<void> => Promise.resolve();
const systemAudit = () => undefined;

/** The Postgres error code behind a rejected promise, looking through the wrapped causes of the repository. */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
      if (current instanceof pg.DatabaseError) return current.code;
      current = current instanceof Error ? current.cause : undefined;
    }
    return 'not-a-database-error';
  }
  return undefined;
}

function store() {
  return createPgVirtualKeyStore(createDatabase(db.appPool));
}

function newKey(overrides: Partial<NewVirtualKey> = {}): { key: string; row: NewVirtualKey } {
  const key = generateVirtualKey();
  const row: NewVirtualKey = {
    id: newId(),
    tenantId: tenantA,
    runId: runA,
    sessionId: sessionA,
    keyPrefix: virtualKeyLookupPrefix(key),
    keySha256: hashVirtualKey(key),
    persona: 'planner',
    scope: { tenantId: tenantA, runId: runA, sessionId: sessionA, persona: 'planner' },
    budgetContext: { costCapUsd: 5 },
    expiresAt: FUTURE,
    ...overrides,
  };
  return { key, row };
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('virtual key store', () => {
  it('mints a key row that is stored by hash and prefix only (the raw key is never persisted)', async () => {
    const { key, row } = newKey();
    const stored = await store().mint(row, noAudit);
    expect(stored).toMatchObject({
      id: row.id,
      tenantId: tenantA,
      persona: 'planner',
      revokedAt: null,
    });
    const dumped = await withTenant(createDatabase(db.appPool), tenantA, (tx) =>
      tx.execute(
        `SELECT row_to_json(v)::text AS body, encode(v.key_sha256, 'hex') AS hash FROM virtual_keys v WHERE v.id = '${row.id}'`,
      ),
    );
    const [record] = dumped.rows as { body: string; hash: string }[];
    expect(record?.hash).toBe(hashVirtualKey(key).toString('hex'));
    expect(record?.body.includes(key)).toBe(false);
  });

  it('isolates tenants: tenant B cannot read or revoke tenant A keys', async () => {
    const { row } = newKey();
    await store().mint(row, noAudit);
    const seenByB = await withTenant(createDatabase(db.appPool), tenantB, (tx) =>
      tx.execute(`SELECT id FROM virtual_keys WHERE id = '${row.id}'`),
    );
    expect(seenByB.rows).toHaveLength(0);
    expect(await store().revokeIds(tenantB, [row.id], noAudit)).toEqual([]);
    expect(await store().revokeRun(tenantB, runA, noAudit)).toEqual([]);
  });

  it('resolves a presented key by its hash, and only by the exact hash', async () => {
    const { key, row } = newKey();
    await store().mint(row, noAudit);
    const found = await store().resolve(hashVirtualKey(key), {
      audit: systemAudit,
      actor: 'test',
      reason: 'test',
    });
    expect(found).toMatchObject({ id: row.id, tenantId: tenantA });
    const other = generateVirtualKey();
    expect(
      await store().resolve(hashVirtualKey(other), {
        audit: systemAudit,
        actor: 'test',
        reason: 'test',
      }),
    ).toBeNull();
  });

  it('revokes every key of a run (gw.vkey.revokeByRun) and is idempotent', async () => {
    const run = newId();
    const first = newKey({ runId: run });
    const second = newKey({ runId: run });
    const other = newKey();
    await store().mint(first.row, noAudit);
    await store().mint(second.row, noAudit);
    await store().mint(other.row, noAudit);
    const revoked = await store().revokeRun(tenantA, run, noAudit);
    expect(revoked.toSorted()).toEqual([first.row.id, second.row.id].toSorted());
    expect(await store().revokeRun(tenantA, run, noAudit)).toEqual([]);
    const authenticate = createVirtualKeyAuthenticator({
      store: store(),
      audit: systemAudit,
      actor: 'test',
    });
    expect(await authenticate(first.key)).toBeUndefined();
    expect(await authenticate(other.key)).toMatchObject({ virtualKeyId: other.row.id });
  });

  it('authenticates a fresh key, stamps last_used_at, and refuses it after revocation', async () => {
    const { key, row } = newKey();
    await store().mint(row, noAudit);
    const authenticate = createVirtualKeyAuthenticator({
      store: store(),
      audit: systemAudit,
      actor: 'test',
    });
    expect(await authenticate(key)).toMatchObject({
      tenantId: tenantA,
      runId: runA,
      persona: 'planner',
    });
    expect(await store().revokeIds(tenantA, [row.id], noAudit)).toEqual([row.id]);
    expect(await authenticate(key)).toBeUndefined();
  });

  it('refuses an expired key', async () => {
    const { key, row } = newKey({ expiresAt: new Date(Date.now() + 2_000) });
    await store().mint(row, noAudit);
    const authenticate = createVirtualKeyAuthenticator({
      store: store(),
      audit: systemAudit,
      actor: 'test',
      now: () => new Date(Date.now() + 10_000),
    });
    expect(await authenticate(key)).toBeUndefined();
  });

  it('keeps the mint and its audit event in one transaction: a failing audit write stores nothing', async () => {
    const { key, row } = newKey();
    await expect(
      store().mint(row, () => Promise.reject(new Error('audit unavailable'))),
    ).rejects.toThrow('audit unavailable');
    expect(
      await store().resolve(hashVirtualKey(key), {
        audit: systemAudit,
        actor: 'test',
        reason: 'test',
      }),
    ).toBeNull();
  });

  it('rejects a malformed prefix, a non-32-byte hash and an expiry not after creation (CHECK)', async () => {
    const bad = (overrides: Partial<NewVirtualKey>) => {
      const { row } = newKey(overrides);
      return pgCode(store().mint(row, noAudit));
    };
    expect(await bad({ keyPrefix: 'nope' })).toBe('23514');
    expect(await bad({ keySha256: Buffer.alloc(16) })).toBe('23514');
    expect(await bad({ expiresAt: new Date(0) })).toBe('23514');
  });

  it('gives the runtime role no DELETE or TRUNCATE on virtual_keys', async () => {
    const deleted = await pgCode(
      db.withTenant(tenantA, (tx) => tx.query('DELETE FROM virtual_keys')),
    );
    expect(deleted).toBe('42501');
    const truncated = await pgCode(
      db.withTenant(tenantA, (tx) => tx.query('TRUNCATE virtual_keys')),
    );
    expect(truncated).toBe('42501');
  });
});
