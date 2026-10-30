// Agent memory storage (MEMORY-001, CONTEXT_PACK §7, §8.6, §8.7): the `memories` and `technique_kb` tables on
// Postgres 16 + pgvector (Testcontainers) against the REAL migrations. Proves tenant isolation and fail-closed
// reads for `memories`, the 384-dim vector contract, the CHECK constraints, the HNSW and dedup indexes, and
// that `technique_kb` is select-only for the app role.

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import {
  expectFailsClosedWithoutContext,
  expectRlsBlocksCrossTenant,
  type PostgresHandle,
  withPostgres,
} from '@blackwing/testing/containers';

import { createDatabase } from './client.js';
import { migrateDatabase } from './migrate.js';
import { CheckViolationError, mapDbError, MemoryEmbedDimMismatchError } from './query-errors.js';
import { EMBEDDING_DIMENSIONS, toVectorLiteral } from './vector.js';
import { withTenant } from './with-tenant.js';

import type pg from 'pg';

let handle: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** A unit vector along `axis`, padded to the 384-dim column. */
function axisVector(axis: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === axis ? 1 : 0));
}

const DEFAULTS = {
  scope: 'tenant',
  kind: 'recon_fact',
  title: 'Login page exposes version banner',
  content: 'The login page reports a framework version in its footer.',
  embed_model: 'bge-small-en-v1.5',
  embed_revision: 'rev-1',
  source: 'agent',
};

/** Inserts one `memories` row for `tenantId`; `overrides` replace any column (the keys are fixed in this file). */
async function insertMemory(
  client: pg.PoolClient,
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = newId();
  const values: Record<string, unknown> = {
    id,
    tenant_id: tenantId,
    embedding: toVectorLiteral(axisVector(0)),
    ...DEFAULTS,
    ...overrides,
  };
  const columns = Object.keys(values);
  const placeholders = columns.map((column, i) =>
    column === 'embedding' ? `$${i + 1}::vector` : `$${i + 1}`,
  );
  await client.query(
    `INSERT INTO memories (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    Object.values(values),
  );
  return id;
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (handle as PostgresHandle | undefined)?.stop();
});

describe('memories: tenant isolation (§8.6)', () => {
  it('a tenant reads its own memory and never another tenant’s', async () => {
    await expect(
      expectRlsBlocksCrossTenant(handle.appPool, 'memories', {
        tenantA,
        tenantB,
        insertRow: (tx, tenantId) => insertMemory(tx, tenantId).then(() => undefined),
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed without app.tenant_id', async () => {
    await expect(
      expectFailsClosedWithoutContext(handle.appPool, 'memories'),
    ).resolves.toBeUndefined();
  });

  it('a foreign-tenant INSERT is refused by WITH CHECK, not silently stored', async () => {
    await expect(
      handle.withTenant(tenantA, (tx) => insertMemory(tx, tenantB)),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('memories: vector contract (DB-005)', () => {
  it('a 384-dim embedding is stored and a nearest-neighbour query orders by cosine distance', async () => {
    const tenant = newId();
    const near = await handle.withTenant(tenant, async (tx) => {
      const nearId = await insertMemory(tx, tenant, { embedding: toVectorLiteral(axisVector(7)) });
      await insertMemory(tx, tenant, { embedding: toVectorLiteral(axisVector(9)) });
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM memories ORDER BY embedding <=> $1::vector LIMIT 1`,
        [toVectorLiteral(axisVector(7))],
      );
      return { nearId, top: rows[0]?.id };
    });
    expect(near.top).toBe(near.nearId);
  });

  it('a wrong-dimension embedding is rejected by Postgres and surfaces as MEMORY_EMBED_DIM_MISMATCH', async () => {
    const tenant = newId();
    const failure = await withTenant(createDatabase(handle.appPool), tenant, (tx) =>
      tx.execute(
        sql`INSERT INTO memories (id, tenant_id, scope, kind, title, content, embedding, embed_model, embed_revision, source)
            VALUES (${newId()}, ${tenant}, 'tenant', 'recon_fact', 't', 'c', ${'[1,2,3]'}::vector, 'm', 'r', 'agent')`,
      ),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MemoryEmbedDimMismatchError);
    expect(failure).toMatchObject({ code: 'MEMORY_EMBED_DIM_MISMATCH', httpStatus: 422 });
  });

  it('HNSW cosine indexes exist on memories and technique_kb', async () => {
    const { rows } = await handle.ownerPool.query<{ tablename: string; indexdef: string }>(
      `SELECT tablename, indexdef FROM pg_indexes
        WHERE tablename IN ('memories', 'technique_kb') AND indexdef LIKE '%USING hnsw%'
        ORDER BY tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual(['memories', 'technique_kb']);
    for (const row of rows) expect(row.indexdef).toContain('vector_cosine_ops');
  });

  it('the tenant, run, kind, scope and dedup_key btree indexes exist', async () => {
    const { rows } = await handle.ownerPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'memories' ORDER BY indexname`,
    );
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      'memories_tenant_id_idx',
      'memories_tenant_run_idx',
      'memories_tenant_kind_idx',
      'memories_tenant_scope_idx',
      'memories_dedup_key_idx',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('memories: constraints and defaults', () => {
  const tenant = newId();

  it('applies the defaults: untrusted, not redacted, empty provenance, no retention', async () => {
    const id = await handle.withTenant(tenant, (tx) => insertMemory(tx, tenant));
    const { rows } = await handle.withTenant(tenant, (tx) =>
      tx.query<{
        trust: string;
        redacted: boolean;
        provenance: Record<string, unknown>;
        retention_until: Date | null;
        legal_hold: boolean;
      }>(
        'SELECT trust, redacted, provenance, retention_until, legal_hold FROM memories WHERE id = $1',
        [id],
      ),
    );
    expect(rows[0]).toEqual({
      trust: 'untrusted',
      redacted: false,
      provenance: {},
      retention_until: null,
      legal_hold: false,
    });
  });

  it('stores a retention_until in the past, so the retention sweeper can find it', async () => {
    const retentionTenant = newId();
    const id = await handle.withTenant(retentionTenant, (tx) =>
      insertMemory(tx, retentionTenant, { retention_until: '2000-01-01T00:00:00Z' }),
    );
    const { rows } = await handle.withTenant(retentionTenant, (tx) =>
      tx.query<{ id: string }>('SELECT id FROM memories WHERE retention_until < now()'),
    );
    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it('keeps the redacted flag and a dedup_key in provenance as written', async () => {
    const dedupTenant = newId();
    await handle.withTenant(dedupTenant, (tx) =>
      insertMemory(tx, dedupTenant, {
        redacted: true,
        provenance: { dedup_key: 'finding:login-banner' },
      }),
    );
    const { rows } = await handle.withTenant(dedupTenant, (tx) =>
      tx.query<{ redacted: boolean; key: string }>(
        `SELECT redacted, provenance->>'dedup_key' AS key FROM memories`,
      ),
    );
    expect(rows).toEqual([{ redacted: true, key: 'finding:login-banner' }]);
  });

  it('allows duplicate logical memories: dedup is MEMORY-009, the index only prepares for it', async () => {
    const dupTenant = newId();
    await handle.withTenant(dupTenant, async (tx) => {
      await insertMemory(tx, dupTenant, { provenance: { dedup_key: 'same' } });
      await insertMemory(tx, dupTenant, { provenance: { dedup_key: 'same' } });
    });
    const { rows } = await handle.withTenant(dupTenant, (tx) =>
      tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM memories WHERE provenance->>'dedup_key' = 'same'`,
      ),
    );
    expect(rows[0]?.n).toBe('2');
  });

  it('bumps updated_at on update through the shared trigger', async () => {
    const updateTenant = newId();
    const id = await handle.withTenant(updateTenant, (tx) => insertMemory(tx, updateTenant));
    const before = await handle.withTenant(updateTenant, (tx) =>
      tx.query<{ updated_at: Date }>('SELECT updated_at FROM memories WHERE id = $1', [id]),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await handle.withTenant(updateTenant, (tx) =>
      tx.query("UPDATE memories SET title = 'renamed' WHERE id = $1", [id]),
    );
    const after = await handle.withTenant(updateTenant, (tx) =>
      tx.query<{ updated_at: Date }>('SELECT updated_at FROM memories WHERE id = $1', [id]),
    );
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]?.updated_at.getTime() ?? Infinity,
    );
  });

  // Each case breaks one CHECK; the raw Postgres error (23514) maps to the typed CheckViolationError (422).
  it.each([
    ['empty content', { content: '   ' }],
    ['empty kind', { kind: ' ' }],
    ['empty title', { title: '' }],
    ['unknown scope', { scope: 'global' }],
    ['run scope without a run', { scope: 'run', run_id: null }],
    ['unknown source', { source: 'user' }],
    ['unknown trust level', { trust: 'trusted' }],
    ['provenance that is not an object', { provenance: '["a"]' }],
    ['empty embedding model', { embed_model: '' }],
    ['empty embedding revision', { embed_revision: ' ' }],
  ])('rejects %s', async (_label, overrides) => {
    const error = await handle
      .withTenant(tenant, (tx) => insertMemory(tx, tenant, overrides))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: '23514' });
    expect(mapDbError(error)).toBeInstanceOf(CheckViolationError);
  });

  it('accepts a run-scoped memory when it carries its run', async () => {
    const runId = newId();
    const id = await handle.withTenant(tenant, (tx) =>
      insertMemory(tx, tenant, { scope: 'run', run_id: runId, provenance: { dedup_key: 'k' } }),
    );
    expect(id).toBeTypeOf('string');
  });
});

describe('technique_kb: platform-global, select-only for tenants (MEMORY-008)', () => {
  it('has no tenant_id column and no row-level security', async () => {
    const { rows } = await handle.ownerPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'technique_kb'`,
    );
    expect(rows.map((r) => r.column_name)).not.toContain('tenant_id');
    const flags = await handle.ownerPool.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'technique_kb'`,
    );
    expect(flags.rows[0]?.relrowsecurity).toBe(false);
  });

  it('the pipeline (owner) writes a technique and the app role reads it with no tenant context', async () => {
    const key = `tech-${newId()}`;
    await handle.ownerPool.query(
      `INSERT INTO technique_kb (id, technique_key, title, body, owasp_refs, wstg_refs, cwe_ids, embedding, embed_model, embed_revision, version)
       VALUES ($1, $2, 'SQL injection', 'Probe quotes.', '{A03}', '{WSTG-INPV-05}', '{CWE-89}', $3::vector, 'bge-small-en-v1.5', 'rev-1', '1')`,
      [newId(), key, toVectorLiteral(axisVector(3))],
    );
    const { rows } = await handle.appPool.query<{ technique_key: string; cwe_ids: string[] }>(
      'SELECT technique_key, cwe_ids FROM technique_kb WHERE technique_key = $1',
      [key],
    );
    expect(rows).toEqual([{ technique_key: key, cwe_ids: ['CWE-89'] }]);
  });

  it('the app role cannot INSERT, UPDATE, DELETE or TRUNCATE it', async () => {
    const attempts = [
      `INSERT INTO technique_kb (id, technique_key, embedding, embed_model, embed_revision)
       VALUES ('${newId()}', 'app-write', '${toVectorLiteral(axisVector(0))}', 'm', 'r')`,
      `UPDATE technique_kb SET title = 'x'`,
      `DELETE FROM technique_kb`,
      `TRUNCATE technique_kb`,
    ];
    for (const statement of attempts) {
      await expect(handle.appPool.query(statement)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('technique_key is unique and a 384-dim embedding is required', async () => {
    const key = `dup-${newId()}`;
    const insert = (embedding: string) =>
      handle.ownerPool.query(
        `INSERT INTO technique_kb (id, technique_key, embedding, embed_model, embed_revision)
         VALUES ($1, $2, $3::vector, 'm', 'r')`,
        [newId(), key, embedding],
      );
    await expect(insert(toVectorLiteral(axisVector(1)))).resolves.toBeDefined();
    await expect(insert(toVectorLiteral(axisVector(1)))).rejects.toMatchObject({ code: '23505' });
    await expect(
      handle.ownerPool.query(
        `INSERT INTO technique_kb (id, technique_key, embedding, embed_model, embed_revision)
         VALUES ($1, $2, '[1,2,3]'::vector, 'm', 'r')`,
        [newId(), `short-${newId()}`],
      ),
    ).rejects.toMatchObject({ code: '22000' });
  });
});
