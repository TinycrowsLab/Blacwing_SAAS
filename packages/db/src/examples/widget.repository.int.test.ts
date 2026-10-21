// widget repository: CRUD, optimistic concurrency, keyset pagination, soft delete, foreign keys,
// audit hook and observability against Postgres 16 (DB-007, Testcontainers).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { NotFoundError, TenantContextMissingError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase } from '../client.js';
import { migrateDatabase } from '../migrate.js';
import {
  ConcurrencyError,
  CursorInvalidError,
  encodeCursor,
  ForeignKeyError,
  type RepositoryAuditEvent,
} from '../repository.js';
import { WidgetRepository } from './widget.repository.js';
import { createWidgetTable } from './widget.test-helpers.js';

let handle: PostgresHandle;
let repo: WidgetRepository;
let current: string | undefined;
const tenantA = newId();
const tenantB = newId();
const audit: RepositoryAuditEvent[] = [];
const logs: { fields: Record<string, unknown>; message: string }[] = [];
const spans: string[] = [];

beforeAll(async () => {
  handle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  await createWidgetTable(handle.ownerPool);
  repo = new WidgetRepository({
    db: createDatabase(handle.appPool),
    tenant: () => current,
    audit: (event) => {
      audit.push(event);
    },
    logger: {
      info: (fields: Record<string, unknown>, message: string) => logs.push({ fields, message }),
    } as never,
    tracer: {
      span: (name, fn) => {
        spans.push(name);
        return fn();
      },
    },
  });
});

afterAll(async () => {
  await handle.stop();
});

async function inTenant<T>(tenant: string | undefined, fn: () => Promise<T>): Promise<T> {
  current = tenant;
  try {
    return await fn();
  } finally {
    current = undefined;
  }
}

describe('CRUD under withTenant', () => {
  it('creates, finds, updates, soft-deletes and deletes a widget', async () => {
    await inTenant(tenantA, async () => {
      const created = await repo.create({ name: '  gear  ', quantity: 3 });
      expect(created).toMatchObject({
        name: 'gear',
        quantity: 3,
        stateVersion: 0,
        tenantId: tenantA,
      });
      expect(created.deletedAt).toBeNull();

      expect(await repo.findById(created.id)).toMatchObject({ id: created.id });

      const updated = await repo.update(created.id, 0, { quantity: 4 });
      expect(updated).toMatchObject({ quantity: 4, stateVersion: 1, name: 'gear' });
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

      const deleted = await repo.softDelete(created.id);
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      expect(deleted.stateVersion).toBe(2);
      expect(await repo.findById(created.id)).toBeUndefined();
      expect(await repo.findById(created.id, { includeDeleted: true })).toMatchObject({
        id: created.id,
      });
      await expect(repo.update(created.id, 2, { quantity: 9 })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(repo.softDelete(created.id)).rejects.toBeInstanceOf(NotFoundError);

      await repo.delete(created.id);
      expect(await repo.findById(created.id, { includeDeleted: true })).toBeUndefined();
      await expect(repo.delete(created.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('refuses to run without a tenant context (fail closed)', async () => {
    await expect(repo.findById(newId())).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(repo.create({ name: 'x' })).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(repo.list()).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('validates inputs at the boundary and never lets a caller choose the tenant', async () => {
    await inTenant(tenantA, async () => {
      await expect(repo.create({ name: '' })).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.create({ name: 'x', tenantId: tenantB } as never)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(repo.findById('not-a-uuid')).rejects.toBeInstanceOf(ValidationError);
      const w = await repo.create({ name: 'guard' });
      await expect(repo.update(w.id, -1, {})).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.update(w.id, 0, { stateVersion: 99 } as never)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });
});

describe('optimistic concurrency', () => {
  it('rejects a stale state_version and increments on the right one', async () => {
    await inTenant(tenantA, async () => {
      const w = await repo.create({ name: 'versioned' });
      await repo.update(w.id, 0, { name: 'v1' });
      const error = await repo.update(w.id, 0, { name: 'lost' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConcurrencyError);
      expect(error).toMatchObject({ code: 'PRECONDITION_FAILED', httpStatus: 412 });
      expect(await repo.update(w.id, 1, { name: 'v2' })).toMatchObject({
        name: 'v2',
        stateVersion: 2,
      });
      await expect(repo.softDelete(w.id, 1)).rejects.toBeInstanceOf(ConcurrencyError);
    });
  });

  it('lets exactly one of several concurrent updates win (no lost update)', async () => {
    await inTenant(tenantA, async () => {
      const w = await repo.create({ name: 'race', quantity: 0 });
      const results = await Promise.allSettled(
        [1, 2, 3, 4, 5].map((quantity) => repo.update(w.id, 0, { quantity })),
      );
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(4);
      for (const r of lost) expect(r.reason).toBeInstanceOf(ConcurrencyError);
      const stored = await repo.findById(w.id);
      expect(stored?.stateVersion).toBe(1);
    });
  });
});

describe('keyset pagination', () => {
  const tenantP = newId();

  it('returns empty pages as { items: [], nextCursor: null }', async () => {
    await inTenant(tenantP, async () => {
      expect(await repo.list()).toEqual({ items: [], nextCursor: null });
    });
  });

  it('pages stably without overlap, gaps or ordering drift', async () => {
    await inTenant(tenantP, async () => {
      const ids: string[] = [];
      for (let i = 0; i < 23; i += 1) ids.push((await repo.create({ name: `p${String(i)}` })).id);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await repo.list({ limit: 5, ...(cursor === undefined ? {} : { cursor }) });
        seen.push(...page.items.map((w) => w.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined);
      expect(pages).toBe(5);
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
      expect(new Set(seen)).toEqual(new Set(ids));
      const all = await repo.list({ limit: 200 });
      expect(all.items.map((w) => w.id)).toEqual(seen);
      expect(all.nextCursor).toBeNull();
    });
  });

  it('breaks created_at ties with the id (rows inserted in one statement)', async () => {
    const tenantT = newId();
    await handle.withTenant(tenantT, async (tx) => {
      await tx.query(
        `INSERT INTO widgets (tenant_id, name, created_at)
         SELECT $1, 't' || g, '2030-01-01T00:00:00Z' FROM generate_series(1, 7) g`,
        [tenantT],
      );
    });
    await inTenant(tenantT, async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await repo.list({ limit: 3, ...(cursor === undefined ? {} : { cursor }) });
        seen.push(...page.items.map((w) => w.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(new Set(seen).size).toBe(7);
      expect([...seen].sort()).toEqual(seen);
    });
  });

  it('defaults the limit to 50, rejects limits above 200 and below 1', async () => {
    await inTenant(tenantP, async () => {
      for (let i = 0; i < 30; i += 1) await repo.create({ name: `d${String(i)}` });
      const page = await repo.list();
      expect(page.items).toHaveLength(50);
      expect(page.nextCursor).not.toBeNull();
      await expect(repo.list({ limit: 201 })).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.list({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.list({ limit: 1.5 })).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('rejects tampered cursors as cursor_invalid', async () => {
    await inTenant(tenantP, async () => {
      const real = (await repo.list({ limit: 1 })).nextCursor ?? '';
      const forged = [
        'garbage!',
        '',
        real.slice(0, -2),
        Buffer.from('{"t":"yesterday","i":"x"}').toString('base64url'),
        Buffer.from('not json').toString('base64url'),
        Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: newId(), x: 1 })).toString(
          'base64url',
        ),
        'A'.repeat(600),
      ];
      for (const cursor of forged) {
        const error = await repo.list({ cursor }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CursorInvalidError);
        expect(error).toMatchObject({ reason: 'cursor_invalid' });
      }
    });
  });

  it('never leaks other tenants rows through a cursor taken from another tenant', async () => {
    const tenantC = newId();
    const tenantD = newId();
    const rowC = await inTenant(tenantC, () => repo.create({ name: 'c-secret' }));
    await inTenant(tenantD, () => repo.create({ name: 'd-visible' }));
    // A cursor positioned before tenant C's row, replayed by tenant D, still only shows D's rows.
    const cursor = encodeCursor({ createdAt: new Date(0), id: rowC.id });
    const page = await inTenant(tenantD, () => repo.list({ cursor }));
    expect(page.items.map((w) => w.name)).toEqual(['d-visible']);
  });

  it('excludes soft-deleted rows by default and includes them on request', async () => {
    const tenantS = newId();
    await inTenant(tenantS, async () => {
      const keep = await repo.create({ name: 'keep' });
      const drop = await repo.create({ name: 'drop' });
      await repo.softDelete(drop.id);
      expect((await repo.list()).items.map((w) => w.id)).toEqual([keep.id]);
      const all = await repo.list({ includeDeleted: true });
      expect(all.items.map((w) => w.id)).toEqual([keep.id, drop.id]);
    });
  });
});

describe('foreign keys', () => {
  it('surfaces a typed ForeignKeyError when deleting a referenced row', async () => {
    await inTenant(tenantA, async () => {
      const parent = await repo.create({ name: 'parent' });
      await repo.create({ name: 'child', parentId: parent.id });
      const error = await repo.delete(parent.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForeignKeyError);
      expect(error).toMatchObject({ code: 'CONFLICT', constraint: 'widgets_parent_fk' });
    });
  });

  it('rejects referencing a missing parent, and a parent of another tenant', async () => {
    const foreign = await inTenant(tenantB, () => repo.create({ name: 'foreign-parent' }));
    await inTenant(tenantA, async () => {
      await expect(repo.create({ name: 'orphan', parentId: newId() })).rejects.toBeInstanceOf(
        ForeignKeyError,
      );
      await expect(repo.create({ name: 'cross', parentId: foreign.id })).rejects.toBeInstanceOf(
        ForeignKeyError,
      );
    });
  });
});

describe('audit hook and observability', () => {
  it('emits an audit event per mutation, inside the transaction, without row contents', async () => {
    audit.length = 0;
    await inTenant(tenantA, async () => {
      const w = await repo.create({ name: 'audited' });
      await repo.update(w.id, 0, { quantity: 1 });
      await repo.softDelete(w.id);
      await repo.delete(w.id);
      expect(audit.map((e) => e.op)).toEqual(['create', 'update', 'soft_delete', 'delete']);
      expect(audit.map((e) => e.stateVersion)).toEqual([0, 1, 2, undefined]);
      for (const event of audit) {
        expect(event).toMatchObject({ entity: 'widget', tenantId: tenantA, id: w.id });
        expect(JSON.stringify(event)).not.toContain('audited');
      }
    });
  });

  it('rolls the mutation back when the audit hook throws', async () => {
    const failing = new WidgetRepository({
      db: createDatabase(handle.appPool),
      tenant: () => tenantA,
      audit: () => {
        throw new Error('ledger down');
      },
    });
    await expect(failing.create({ name: 'never-stored' })).rejects.toThrow('ledger down');
    const names = await inTenant(tenantA, () => repo.list({ limit: 200 }));
    expect(names.items.map((w) => w.name)).not.toContain('never-stored');
  });

  it('opens a repo.<entity>.<op> span and logs counts only', async () => {
    spans.length = 0;
    logs.length = 0;
    await inTenant(tenantA, async () => {
      const w = await repo.create({ name: 'secret-name' });
      await repo.findById(w.id);
    });
    expect(spans).toEqual(['repo.widget.create', 'repo.widget.findById']);
    expect(logs[0]).toEqual({
      fields: { entity: 'widget', op: 'create', tenantId: tenantA, rowCount: 1 },
      message: 'db.repo',
    });
    expect(JSON.stringify(logs)).not.toContain('secret-name');
  });
});

describe('no raw pool access', () => {
  it('goes through the pool only inside a tenant transaction; raw pool access fails closed', async () => {
    const spy = vi.spyOn(handle.appPool, 'connect');
    await inTenant(tenantA, () => repo.list());
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    await expect(handle.appPool.query('SELECT * FROM widgets')).rejects.toThrow(
      /app\.tenant_id|uuid/,
    );
  });
});
