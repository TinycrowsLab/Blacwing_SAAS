// Service accounts (RBAC-005) against the real migrations on Postgres (Testcontainers): the audit write in the
// same transaction, the unique name, the database-side role and owner guards, the soft disable, and tenant
// isolation through RLS. Needs Docker; run with `pnpm --filter @blackwing/api test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuditEmitter, createAuditEmitter } from '@blackwing/audit';
import { createDatabase, ForeignKeyError, migrateDatabase } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { ServiceAccountRepository, type ServiceAccountAuditContext } from './repository.js';

import type { Role } from '@blackwing/contracts';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const ownerA = newId();
const ownerB = newId();
const CONTEXT: ServiceAccountAuditContext = { actor: { type: 'user', id: ownerA } };

/** Postgres error code of a rejected promise (23505 unique, 23514 check, 23503 FK, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

function repoFor(tenantId: string, audit: AuditEmitter = createAuditEmitter()) {
  return new ServiceAccountRepository({
    db: createDatabase(db.appPool),
    audit,
    tenant: () => tenantId,
  });
}

/** The audit actions the ledger holds for one tenant's service accounts, in write order. */
async function auditActions(tenantId: string): Promise<readonly string[]> {
  const result = await db.withTenant(tenantId, (tx) =>
    tx.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action LIKE 'service_account.%' ORDER BY id",
    ),
  );
  return result.rows.map((row) => row.action);
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  for (const [tenantId, slug] of [
    [tenantA, 'sa-tenant-a'],
    [tenantB, 'sa-tenant-b'],
  ] as const) {
    await db.withTenant(tenantId, (tx) =>
      tx.query(
        `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, $2, $3, 'eu-west-1', 'team')`,
        [tenantId, slug, `Tenant ${slug}`],
      ),
    );
  }
  for (const [userId, sub] of [
    [ownerA, 'sa-owner-a'],
    [ownerB, 'sa-owner-b'],
  ] as const) {
    await db.ownerPool.query(
      `INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, $2, $3, 'Owner')`,
      [userId, sub, `${sub}@example.test`],
    );
  }
  await db.withTenant(tenantA, (tx) =>
    tx.query(`INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, '{org_admin}')`, [
      tenantA,
      ownerA,
    ]),
  );
  await db.withTenant(tenantB, (tx) =>
    tx.query(`INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, '{org_admin}')`, [
      tenantB,
      ownerB,
    ]),
  );
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

let counter = 0;
const uniqueName = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}`;
};

describe('service account repository: writes and audit', () => {
  it('creates the account and writes service_account.created in the same transaction', async () => {
    const row = await repoFor(tenantA).insert(
      { name: uniqueName('ci'), roles: ['ci_pipeline'] as Role[], ownerUserId: ownerA },
      CONTEXT,
    );
    expect(row).toMatchObject({ tenantId: tenantA, status: 'active', stateVersion: 0 });
    expect(await auditActions(tenantA)).toContain('service_account.created');
  });

  it('rolls the change back when its audit write fails: nothing is stored unaudited', async () => {
    const name = uniqueName('unaudited');
    const failing = createAuditEmitter();
    const broken: AuditEmitter = {
      ...failing,
      emitAuditInTx: () => Promise.reject(new Error('audit unavailable')),
    };
    await expect(
      repoFor(tenantA, broken).insert(
        { name, roles: ['developer'] as Role[], ownerUserId: ownerA },
        CONTEXT,
      ),
    ).rejects.toThrow('audit unavailable');
    const page = await repoFor(tenantA).list();
    expect(page.items.map((row) => row.name)).not.toContain(name);
  });

  it('refuses a second account with the same name in the tenant (unique per tenant)', async () => {
    const name = uniqueName('dup');
    const repo = repoFor(tenantA);
    await repo.insert({ name, roles: [], ownerUserId: ownerA }, CONTEXT);
    await expect(repo.insert({ name, roles: [], ownerUserId: ownerA }, CONTEXT)).rejects.toThrow();
  });

  it('patches at the matching version, bumps the version and audits the changed field names only', async () => {
    const repo = repoFor(tenantA);
    const created = await repo.insert(
      { name: uniqueName('patch'), roles: [], ownerUserId: ownerA },
      CONTEXT,
    );
    const updated = await repo.patch(created.id, 0, { roles: ['developer'] as Role[] }, CONTEXT);
    expect(updated).toMatchObject({ stateVersion: 1, roles: ['developer'] });
    const audit = await db.withTenant(tenantA, (tx) =>
      tx.query<{ metadata: { changedFields: string[] } }>(
        "SELECT metadata FROM audit_events WHERE action = 'service_account.updated' AND target->>'id' = $1",
        [created.id],
      ),
    );
    expect(audit.rows).toEqual([{ metadata: { changedFields: ['roles'] } }]);
  });

  it('refuses a stale version and leaves the account unchanged', async () => {
    const repo = repoFor(tenantA);
    const created = await repo.insert(
      { name: uniqueName('stale'), roles: [], ownerUserId: ownerA },
      CONTEXT,
    );
    await repo.patch(created.id, 0, { description: 'first' }, CONTEXT);
    await expect(repo.patch(created.id, 0, { description: 'second' }, CONTEXT)).rejects.toThrow(
      /modified concurrently/,
    );
    expect(await repo.findById(created.id)).toMatchObject({
      description: 'first',
      stateVersion: 1,
    });
  });

  it('disables softly: the row stays, is audited, and the runtime role cannot delete it', async () => {
    const repo = repoFor(tenantA);
    const created = await repo.insert(
      { name: uniqueName('disable'), roles: [], ownerUserId: ownerA },
      CONTEXT,
    );
    const disabled = await repo.disable(created.id, 0, CONTEXT);
    expect(disabled).toMatchObject({ status: 'disabled', stateVersion: 1 });
    expect(await repo.findById(created.id)).toMatchObject({ status: 'disabled' });
    expect(await auditActions(tenantA)).toContain('service_account.disabled');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query('DELETE FROM service_accounts WHERE id = $1', [created.id]),
        ),
      ),
    ).toBe('42501');
  });

  it('a second disable of a disabled account changes nothing and writes no second event', async () => {
    const repo = repoFor(tenantA);
    const created = await repo.insert(
      { name: uniqueName('twice'), roles: [], ownerUserId: ownerA },
      CONTEXT,
    );
    await repo.disable(created.id, 0, CONTEXT);
    const again = await repo.disable(created.id, 1, CONTEXT);
    expect(again).toMatchObject({ status: 'disabled', stateVersion: 1 });
    const events = await db.withTenant(tenantA, (tx) =>
      tx.query(
        "SELECT id FROM audit_events WHERE action = 'service_account.disabled' AND target->>'id' = $1",
        [created.id],
      ),
    );
    expect(events.rowCount).toBe(1);
  });
});

describe('service account repository: database guards', () => {
  it('refuses an approval or admin role even when the writer skips the application check', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO service_accounts (tenant_id, name, roles, owner_user_id) VALUES ($1, $2, '{org_admin}', $3)`,
          [tenantA, uniqueName('raw-admin'), ownerA],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('refuses an owner who is not a member of the tenant (no cross-tenant owner link)', async () => {
    await expect(
      repoFor(tenantA).insert(
        { name: uniqueName('foreign-owner'), roles: [], ownerUserId: ownerB },
        CONTEXT,
      ),
    ).rejects.toBeInstanceOf(ForeignKeyError);
  });
});

describe('service account repository: tenant isolation', () => {
  it("tenant B cannot read, list or change tenant A's account", async () => {
    const a = repoFor(tenantA);
    const created = await a.insert(
      { name: uniqueName('private'), roles: [], ownerUserId: ownerA },
      CONTEXT,
    );
    const b = repoFor(tenantB);
    expect(await b.findById(created.id)).toBeUndefined();
    expect((await b.list()).items.map((row) => row.id)).not.toContain(created.id);
    await expect(b.patch(created.id, 0, { description: 'stolen' }, CONTEXT)).rejects.toThrow(
      'service account not found',
    );
    await expect(b.disable(created.id, 0, CONTEXT)).rejects.toThrow('service account not found');
    expect(await a.findById(created.id)).toMatchObject({ description: null, status: 'active' });
  });

  it('tenant B cannot link its own account to a tenant A owner either', async () => {
    await expect(
      repoFor(tenantB).insert(
        { name: uniqueName('cross-owner'), roles: [], ownerUserId: ownerA },
        CONTEXT,
      ),
    ).rejects.toBeInstanceOf(ForeignKeyError);
  });
});
