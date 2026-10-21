// CROSS-TENANT TEST TEMPLATE (DB-007, CONTEXT_PACK §8.6, Definition of Done §10). Every domain epic
// copies this file for its repository and adapts the three marked parts: the repository factory, the
// seed row and the mutation. The assertions stay: tenant B must never read, list, update, delete or
// reference tenant A's data, and a request without tenant context must fail closed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotFoundError, TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase } from '../client.js';
import { migrateDatabase } from '../migrate.js';
import { WidgetRepository } from './widget.repository.js'; // (1) your repository
import { createWidgetTable } from './widget.test-helpers.js'; // (1) your table setup

let handle: PostgresHandle;
let current: string | undefined;
let repo: WidgetRepository;
const tenantA = newId();
const tenantB = newId();

/** Runs `fn` with `tenant` as the ambient tenant context. */
async function as<T>(tenant: string | undefined, fn: () => Promise<T>): Promise<T> {
  current = tenant;
  try {
    return await fn();
  } finally {
    current = undefined;
  }
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  await createWidgetTable(handle.ownerPool);
  repo = new WidgetRepository({ db: createDatabase(handle.appPool), tenant: () => current });
});

afterAll(async () => {
  await handle.stop();
});

describe('widget repository: tenant isolation', () => {
  // (2) seed one row for tenant A
  async function seedA() {
    return as(tenantA, () => repo.create({ name: 'a-only', quantity: 1 }));
  }

  it("tenant B cannot find tenant A's row by id", async () => {
    const row = await seedA();
    expect(await as(tenantB, () => repo.findById(row.id))).toBeUndefined();
    expect(
      await as(tenantB, () => repo.findById(row.id, { includeDeleted: true })),
    ).toBeUndefined();
  });

  it("tenant B's list never contains tenant A's rows", async () => {
    const row = await seedA();
    await as(tenantB, () => repo.create({ name: 'b-only' }));
    const page = await as(tenantB, () => repo.list({ limit: 200, includeDeleted: true }));
    expect(page.items.map((r) => r.id)).not.toContain(row.id);
    expect(page.items.every((r) => r.tenantId === tenantB)).toBe(true);
  });

  it("tenant B cannot update, soft-delete or delete tenant A's row (it looks missing)", async () => {
    const row = await seedA();
    // (3) your mutation
    await expect(
      as(tenantB, () => repo.update(row.id, row.stateVersion, { name: 'pwn' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(as(tenantB, () => repo.softDelete(row.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(as(tenantB, () => repo.delete(row.id))).rejects.toBeInstanceOf(NotFoundError);
    expect(await as(tenantA, () => repo.findById(row.id))).toMatchObject({
      name: 'a-only',
      stateVersion: row.stateVersion,
    });
  });

  it('the tenant is never taken from input: a smuggled tenantId is rejected', async () => {
    await expect(
      as(tenantB, () => repo.create({ name: 'x', tenantId: tenantA } as never)),
    ).rejects.toThrow();
  });

  it('fails closed without a tenant context, and with a malformed one', async () => {
    await expect(as(undefined, () => repo.list())).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    await expect(as('not-a-uuid', () => repo.list())).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    await expect(as('', () => repo.create({ name: 'x' }))).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });

  it('the database itself denies cross-tenant access even if a repository filter were missing', async () => {
    const row = await seedA();
    const visible = await handle.withTenant(tenantB, (tx) =>
      tx.query('SELECT id FROM widgets WHERE id = $1', [row.id]),
    );
    expect(visible.rows).toHaveLength(0);
    await expect(
      handle.withTenant(tenantB, (tx) =>
        tx.query('INSERT INTO widgets (tenant_id, name) VALUES ($1, $2)', [tenantA, 'forged']),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
