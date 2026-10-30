// The Postgres secrets store (SECRETS-004) against the real migrations on Postgres (Testcontainers): the
// create, replay and name conflict through the unique indexes, versioning under the row lock, the disable
// transition, the audit event committed with each write, and cross-tenant isolation. Needs Docker; run
// with `pnpm --filter @blackwing/api test:int`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type Database, migrateDatabase } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { PostgresSecretStore, PostgresSecretUsage } from './postgres.js';

import type { SecretAuditRecord, SecretMetadata } from './ports.js';
import type { Envelope } from '@blackwing/secrets';

let pg: PostgresHandle;
let database: Database;
let store: PostgresSecretStore;
let usage: PostgresSecretUsage;
let tenantA = newId();
let tenantB = newId();
const NOW = '2026-10-30T10:00:00.000Z';

/** A structurally valid SECRETS-002 envelope. The store persists it as an opaque JSON object. */
const ENVELOPE = {
  v: 1,
  alg: 'AES-256-GCM',
  kekKey: 'kek-a',
  kekVersion: 1,
  wrappedDek: 'vault:v1:AAAA',
  iv: 'AAAA',
  tag: 'AAAA',
  ct: 'AAAA',
  aadHash: 'AAAA',
} as unknown as Envelope;

function audit(
  tenantId: string,
  action: SecretAuditRecord['action'],
  secretId: string,
): SecretAuditRecord {
  return {
    action,
    severity: 'notice',
    outcome: 'success',
    tenantId,
    actor: { type: 'user', id: newId() },
    target: { type: 'secret_ref', id: secretId },
    occurredAt: NOW,
    traceId: null,
    metadata: { version: 1 },
  };
}

function secretFor(tenantId: string, overrides: Partial<SecretMetadata> = {}): SecretMetadata {
  return {
    id: newId(),
    tenantId,
    name: `secret-${newId()}`,
    type: 'api_key',
    purpose: null,
    backend: 'openbao',
    status: 'active',
    currentVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function newSecret(tenantId: string, keyHash: string, overrides: Partial<SecretMetadata> = {}) {
  const secret = secretFor(tenantId, overrides);
  return {
    secret,
    envelope: ENVELOPE,
    idempotency: { keyHash, fingerprint: `fp-${keyHash}` },
    audit: audit(tenantId, 'secret.created', secret.id),
  };
}

/** Counts audit ledger rows of one action as the tenant (the ledger is tenant-scoped under RLS). */
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

beforeAll(async () => {
  pg = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  database = createDatabase(pg.appPool);
  store = new PostgresSecretStore(database);
  usage = new PostgresSecretUsage(database);
}, 120_000);

afterAll(async () => {
  await pg.stop();
});

beforeEach(() => {
  tenantA = newId();
  tenantB = newId();
});

describe('PostgresSecretStore', () => {
  it('creates a secret with its first version and commits the audit event with it', async () => {
    const input = newSecret(tenantA, `k-${newId()}`);
    const result = await store.create(input);

    expect(result).toEqual({ kind: 'created', secret: input.secret });
    expect(await store.get(tenantA, input.secret.id)).toEqual(input.secret);
    expect(await auditCount(tenantA, 'secret.created')).toBe(1);
  });

  it('returns the first secret for a replayed idempotency key, with its fingerprint', async () => {
    const keyHash = `k-${newId()}`;
    const first = newSecret(tenantA, keyHash);
    await store.create(first);

    const replay = await store.create(newSecret(tenantA, keyHash));
    expect(replay).toEqual({
      kind: 'idempotent_replay',
      secret: first.secret,
      fingerprint: first.idempotency.fingerprint,
    });
    expect(await store.findByIdempotencyKey(tenantA, keyHash)).toEqual({
      secret: first.secret,
      fingerprint: first.idempotency.fingerprint,
    });
    expect(await store.findByIdempotencyKey(tenantB, keyHash)).toBeNull();
  });

  it('answers a duplicate name in the tenant with a conflict and writes nothing', async () => {
    const first = newSecret(tenantA, `k-${newId()}`, { name: 'db-password' });
    await store.create(first);

    const clash = await store.create(newSecret(tenantA, `k-${newId()}`, { name: 'db-password' }));
    expect(clash).toEqual({ kind: 'name_conflict' });
    expect(await store.list(tenantA, { limit: 10 })).toHaveLength(1);
    expect(await auditCount(tenantA, 'secret.created')).toBe(1);
  });

  it('allows the same name in another tenant', async () => {
    await store.create(newSecret(tenantA, `k-${newId()}`, { name: 'shared-name' }));
    const other = await store.create(newSecret(tenantB, `k-${newId()}`, { name: 'shared-name' }));
    expect(other.kind).toBe('created');
  });

  it('never returns another tenant’s secret', async () => {
    const input = newSecret(tenantA, `k-${newId()}`);
    await store.create(input);

    expect(await store.get(tenantB, input.secret.id)).toBeNull();
    expect(await store.list(tenantB, { limit: 10 })).toEqual([]);
    expect(
      await store.addVersion({
        tenantId: tenantB,
        secretId: input.secret.id,
        envelope: ENVELOPE,
        now: NOW,
        audit: (after) => audit(tenantB, 'secret.updated', after.id),
      }),
    ).toEqual({ kind: 'not_found' });
  });

  it('pages secrets by id after the cursor', async () => {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const input = newSecret(tenantA, `k-${newId()}`);
      ids.push(input.secret.id);
      await store.create(input);
    }
    ids.sort();

    const firstPage = await store.list(tenantA, { limit: 2 });
    expect(firstPage.map((s) => s.id)).toEqual(ids.slice(0, 2));
    const cursor = firstPage[firstPage.length - 1]?.id;
    const next = await store.list(tenantA, {
      ...(cursor === undefined ? {} : { afterId: cursor }),
      limit: 2,
    });
    expect(next.map((s) => s.id)).toEqual(ids.slice(2));
  });

  it('adds a version under the row lock: bumps the current version and refuses a stale one', async () => {
    const input = newSecret(tenantA, `k-${newId()}`);
    await store.create(input);

    const stale = await store.addVersion({
      tenantId: tenantA,
      secretId: input.secret.id,
      envelope: ENVELOPE,
      expectedVersion: 7,
      now: NOW,
      audit: (after) => audit(tenantA, 'secret.updated', after.id),
    });
    expect(stale).toEqual({ kind: 'stale' });

    const updated = await store.addVersion({
      tenantId: tenantA,
      secretId: input.secret.id,
      envelope: ENVELOPE,
      expectedVersion: 1,
      now: NOW,
      audit: (after) => audit(tenantA, 'secret.updated', after.id),
    });
    expect(updated.kind).toBe('updated');
    expect(updated).toMatchObject({ kind: 'updated', secret: { currentVersion: 2 } });
    expect(await auditCount(tenantA, 'secret.updated')).toBe(1);
  });

  it('disables a secret once, then refuses new versions for it', async () => {
    const input = newSecret(tenantA, `k-${newId()}`);
    await store.create(input);
    const disable = {
      tenantId: tenantA,
      secretId: input.secret.id,
      now: NOW,
      audit: (after: SecretMetadata) => audit(tenantA, 'secret.deleted', after.id),
    };

    const first = await store.disable(disable);
    expect(first.kind).toBe('disabled');
    expect(await store.disable(disable)).toMatchObject({ kind: 'unchanged' });
    expect(await auditCount(tenantA, 'secret.deleted')).toBe(1);

    expect(
      await store.addVersion({
        tenantId: tenantA,
        secretId: input.secret.id,
        envelope: ENVELOPE,
        now: NOW,
        audit: (after) => audit(tenantA, 'secret.updated', after.id),
      }),
    ).toEqual({ kind: 'inactive', status: 'disabled' });
  });

  it('reports which resources still reference a secret, and none for an unreferenced one', async () => {
    const input = newSecret(tenantA, `k-${newId()}`);
    await store.create(input);
    expect(await usage.referencingTypes(tenantA, input.secret.id)).toEqual([]);
  });
});
