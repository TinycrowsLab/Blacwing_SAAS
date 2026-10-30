// tenant-policy.rls: append-only versions, the single active pointer, activation and rollback, and tenant
// isolation for the `policies` table (POLICY-001, CONTEXT_PACK §7, §8.6, §8.8, §8.11). Runs the real migrations
// against Postgres 16 (Testcontainers) and goes through the app role, so RLS and the grants apply.

import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase } from './client.js';
import { migrateDatabase } from './index.js';
import { ConcurrencyError } from './repository.js';
import {
  PolicyVersionNotFoundError,
  TenantPolicyRepository,
  type TenantPolicyAuditEvent,
} from './tenant-policy.repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const actor = newId();
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Postgres error code of a rejected promise (23514 check, 42501 insufficient privilege, 23505 unique). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

/** Runs `fn` as the owner role inside a transaction scoped to `tenantId` (the owner is subject to FORCE RLS too). */
async function asOwner<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function makeRepo(events: TenantPolicyAuditEvent[] = []) {
  return new TenantPolicyRepository({
    db: createDatabase(db.appPool),
    audit: (event) => {
      events.push(event);
    },
  });
}

const SOURCE_A = 'permit (principal, action, resource);\n';
const SOURCE_B = 'forbid (principal, action, resource) when { false };\n';

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
});

afterAll(async () => {
  await db.stop();
});

describe('tenant policy versions (POLICY-001)', () => {
  it('starts with the empty version 1, appends new versions and never updates one', async () => {
    const events: TenantPolicyAuditEvent[] = [];
    const repo = makeRepo(events);
    expect(await repo.getActive(tenantA)).toBeUndefined();

    const v2 = await repo.createVersion({
      tenantId: tenantA,
      cedarSource: SOURCE_A,
      sha256: sha(SOURCE_A),
      actorId: actor,
      note: 'first real policy',
    });
    expect(v2.version).toBe(2);
    expect(v2.active).toBe(false);
    expect(v2.note).toBe('first real policy');

    const v1 = await repo.getVersion(tenantA, 1);
    expect(v1?.cedarSource).toBe('');
    expect(v1?.sha256).toBe(sha(''));

    const history = await repo.listVersions(tenantA, 10);
    expect(history.map((v) => v.version)).toEqual([2, 1]);
    expect(history[0]).not.toHaveProperty('cedarSource');

    expect(
      events.map((e) => [e.action, e.action === 'policy.version.created' && e.version]),
    ).toEqual([
      ['policy.version.created', 1],
      ['policy.version.created', 2],
    ]);
  });

  it('refuses a change to stored content at the database, for the app and the owner roles', async () => {
    const repo = makeRepo();
    const v2 = await repo.getVersion(tenantA, 2);
    expect(v2).toBeDefined();
    const appUpdate = db.withTenant(tenantA, (tx) =>
      tx.query('UPDATE policies SET cedar_source = $1 WHERE id = $2', [
        'permit(principal,action,resource);',
        v2?.id,
      ]),
    );
    expect(await pgCode(appUpdate)).toBe('42501');
    const ownerUpdate = asOwner(tenantA, (c) =>
      c.query('UPDATE policies SET cedar_source = $1 WHERE id = $2', ['x', v2?.id]),
    );
    expect(await pgCode(ownerUpdate)).toBe('23514');
    expect(await pgCode(db.withTenant(tenantA, (tx) => tx.query('DELETE FROM policies')))).toBe(
      '42501',
    );
  });

  it('refuses a version born active and a source over the size cap', async () => {
    const active = db.withTenant(tenantA, (tx) =>
      tx.query(
        `INSERT INTO policies (id, tenant_id, version, cedar_source, sha256, author, active)
         VALUES ($1, $2, 99, '', $3, $4, true)`,
        [newId(), tenantA, sha(''), actor],
      ),
    );
    expect(await pgCode(active)).toBe('23514');
    const huge = 'a'.repeat(262_145);
    const oversized = db.withTenant(tenantA, (tx) =>
      tx.query(
        `INSERT INTO policies (id, tenant_id, version, cedar_source, sha256, author)
         VALUES ($1, $2, 99, $3, $4, $5)`,
        [newId(), tenantA, huge, sha(huge), actor],
      ),
    );
    expect(await pgCode(oversized)).toBe('23514');
  });

  it('activates a version, swapping the pointer atomically, and refuses a stale expectation', async () => {
    const repo = makeRepo();
    const first = await repo.activate({
      tenantId: tenantA,
      version: 2,
      expectedActiveVersion: null,
      actorId: actor,
    });
    expect(first).toMatchObject({ changed: true, previousVersion: null });
    expect((await repo.getActive(tenantA))?.version).toBe(2);

    const v3 = await repo.createVersion({
      tenantId: tenantA,
      cedarSource: SOURCE_B,
      sha256: sha(SOURCE_B),
      actorId: actor,
    });
    await expect(
      repo.activate({
        tenantId: tenantA,
        version: v3.version,
        expectedActiveVersion: null,
        actorId: actor,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect((await repo.getActive(tenantA))?.version).toBe(2);

    const swap = await repo.activate({
      tenantId: tenantA,
      version: v3.version,
      expectedActiveVersion: 2,
      actorId: actor,
    });
    expect(swap).toMatchObject({ changed: true, previousVersion: 2 });
    const activeRows = await asOwner(tenantA, (c) =>
      c.query('SELECT version FROM policies WHERE active ORDER BY version'),
    );
    expect(activeRows.rows.map((r: { version: number }) => r.version)).toEqual([3]);
  });

  it('activating the already active version is a no-op with nothing audited', async () => {
    const events: TenantPolicyAuditEvent[] = [];
    const repo = makeRepo(events);
    const result = await repo.activate({
      tenantId: tenantA,
      version: 3,
      expectedActiveVersion: 3,
      actorId: actor,
    });
    expect(result).toMatchObject({ changed: false, previousVersion: 3 });
    expect(events).toEqual([]);
  });

  it('lets exactly one of two concurrent activations win', async () => {
    const repo = makeRepo();
    const v4 = await repo.createVersion({
      tenantId: tenantA,
      cedarSource: SOURCE_A,
      sha256: sha(SOURCE_A),
      actorId: actor,
    });
    const v5 = await repo.createVersion({
      tenantId: tenantA,
      cedarSource: SOURCE_B,
      sha256: sha(SOURCE_B),
      actorId: actor,
    });
    const outcomes = await Promise.allSettled([
      repo.activate({
        tenantId: tenantA,
        version: v4.version,
        expectedActiveVersion: 3,
        actorId: actor,
      }),
      repo.activate({
        tenantId: tenantA,
        version: v5.version,
        expectedActiveVersion: 3,
        actorId: actor,
      }),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toBeInstanceOf(ConcurrencyError);
    const activeRows = await asOwner(tenantA, (c) =>
      c.query('SELECT count(*)::int AS n FROM policies WHERE active'),
    );
    expect(activeRows.rows[0]).toEqual({ n: 1 });
  });

  it('refuses to activate a version the tenant does not have, and audits nothing', async () => {
    const events: TenantPolicyAuditEvent[] = [];
    const repo = makeRepo(events);
    const error = await repo
      .activate({ tenantId: tenantA, version: 404, expectedActiveVersion: null, actorId: actor })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyVersionNotFoundError);
    expect(error).toMatchObject({ code: 'POLICY_VERSION_NOT_FOUND', httpStatus: 404 });
    expect(events).toEqual([]);
  });

  it('rolls back to an earlier version, records the event and keeps the history intact', async () => {
    const events: TenantPolicyAuditEvent[] = [];
    const repo = makeRepo(events);
    const before = await repo.listVersions(tenantA, 50);
    const current = (await repo.getActive(tenantA))?.version ?? 0;
    expect(current).toBeGreaterThan(2);
    const result = await repo.rollback({
      tenantId: tenantA,
      toVersion: 2,
      expectedActiveVersion: current,
      actorId: actor,
    });
    expect(result).toMatchObject({ changed: true, previousVersion: current });
    expect((await repo.getActive(tenantA))?.version).toBe(2);
    expect(await repo.listVersions(tenantA, 50)).toEqual(
      before.map((v) => ({ ...v, active: v.version === 2 })),
    );
    expect(events.at(-1)).toEqual({
      action: 'policy.rolled_back',
      tenantId: tenantA,
      actorId: actor,
      toVersion: 2,
      previousVersion: current,
    });
  });

  it('rolls the activation back when the audit write fails', async () => {
    const failing = new TenantPolicyRepository({
      db: createDatabase(db.appPool),
      audit: () => {
        throw new Error('audit ledger unavailable');
      },
    });
    await expect(
      failing.activate({ tenantId: tenantA, version: 1, expectedActiveVersion: 2, actorId: actor }),
    ).rejects.toThrow('audit ledger unavailable');
    expect((await makeRepo().getActive(tenantA))?.version).toBe(2);
  });

  it('isolates tenants: another tenant sees, activates and inserts nothing of this one', async () => {
    const repoB = makeRepo();
    expect(await repoB.getVersion(tenantB, 2)).toBeUndefined();
    expect(await repoB.getActive(tenantB)).toBeUndefined();
    expect(await repoB.listVersions(tenantB, 10)).toEqual([]);
    await expect(
      repoB.activate({
        tenantId: tenantB,
        version: 2,
        expectedActiveVersion: null,
        actorId: actor,
      }),
    ).rejects.toBeInstanceOf(PolicyVersionNotFoundError);
    const crossInsert = db.withTenant(tenantB, (tx) =>
      tx.query(
        `INSERT INTO policies (id, tenant_id, version, cedar_source, sha256, author)
         VALUES ($1, $2, 50, '', $3, $4)`,
        [newId(), tenantA, sha(''), actor],
      ),
    );
    expect(await pgCode(crossInsert)).toBe('42501');
  });

  it('fails closed without a tenant context', async () => {
    // `app.tenant_id` is unset: the RLS predicate errors instead of matching every row.
    const code = await pgCode(db.appPool.query('SELECT count(*) FROM policies'));
    expect(code).toBeDefined();
    expect(code).not.toBe('not-a-database-error');
  });
});
