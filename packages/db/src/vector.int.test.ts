// vector: pgvector against Postgres 16 + pgvector (DB-005, Testcontainers). The extensions exist after the
// migrations, an embedding table with embeddingColumn() + hnswIndex() builds, nearest-neighbour ordering with
// `<=>` is correct, a wrong-length vector is rejected at the boundary and by the database, and an embedding
// is tenant-scoped (RLS) like any other tenant table.

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { pgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { idColumn, tenantIdColumn, tenantIdIndex } from './columns.js';
import { migrateDatabase } from './migrate.js';
import { rlsPolicySql } from './rls.js';
import {
  EMBEDDING_DIMENSIONS,
  embeddingColumn,
  embeddingDistance,
  hnswEfSearchSql,
  hnswIndex,
  parseEmbedding,
  toVectorLiteral,
} from './vector.js';

const probe = pgTable(
  'vector_probe',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    embedding: embeddingColumn(),
  },
  (t) => [tenantIdIndex('vector_probe', t.tenantId), hnswIndex('vector_probe', t.embedding)],
);

let handle: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** A unit vector along axis `axis` (all other components zero), padded to 384 dimensions. */
function axisVector(axis: number, weight = 1): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === axis ? weight : 0));
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  const ddl = (
    await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ probe }))
  ).join('\n');
  await handle.ownerPool.query(ddl);
  await handle.ownerPool.query(rlsPolicySql(probe));
}, 180_000);

afterAll(async () => {
  await handle.stop();
});

async function insert(tenant: string, embedding: number[]): Promise<string> {
  const id = newId();
  await handle.withTenant(tenant, (tx) =>
    tx.query('INSERT INTO vector_probe (id, tenant_id, embedding) VALUES ($1, $2, $3::vector)', [
      id,
      tenant,
      toVectorLiteral(embedding),
    ]),
  );
  return id;
}

describe('pgvector extensions', () => {
  it('vector and pgcrypto are installed by the migrations', async () => {
    const { rows } = await handle.ownerPool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto') ORDER BY extname",
    );
    expect(rows.map((r) => r.extname)).toEqual(['pgcrypto', 'vector']);
  });

  it('re-running the migrations is a no-op (the extension statements are idempotent)', async () => {
    const client = await handle.ownerPool.connect();
    try {
      const result = await migrateDatabase(client);
      expect(result.applied).toEqual([]);
    } finally {
      client.release();
    }
  });
});

describe('embedding table and HNSW index', () => {
  it('the column is vector(384) and the hnsw index uses cosine ops with m=16, ef_construction=64', async () => {
    const { rows: columns } = await handle.ownerPool.query<{ type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid WHERE c.relname = 'vector_probe' AND a.attname = 'embedding'`,
    );
    expect(columns[0]?.type).toBe('vector(384)');

    const { rows: indexes } = await handle.ownerPool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'vector_probe' AND indexname = 'vector_probe_embedding_hnsw_idx'`,
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain('USING hnsw');
    expect(indexes[0]?.indexdef).toContain('vector_cosine_ops');
    const { rows: options } = await handle.ownerPool.query<{ reloptions: string[] }>(
      `SELECT reloptions FROM pg_class WHERE relname = 'vector_probe_embedding_hnsw_idx'`,
    );
    expect(options[0]?.reloptions.toSorted()).toEqual(['ef_construction=64', 'm=16']);
  });
});

describe('nearest-neighbour search', () => {
  const tenant = newId();
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ids.axis0 = await insert(tenant, axisVector(0));
    ids.axis1 = await insert(tenant, axisVector(1));
    ids.axis2 = await insert(tenant, axisVector(2));
    ids.near0 = await insert(
      tenant,
      axisVector(0, 0.9).map((v, i) => (i === 1 ? 0.1 : v)),
    );
  });

  it('orders rows by cosine distance (<=>), nearest first', async () => {
    const query = axisVector(0);
    const { rows } = await handle.withTenant(tenant, async (tx) => {
      await tx.query(hnswEfSearchSql());
      return tx.query<{ id: string }>(
        'SELECT id FROM vector_probe ORDER BY embedding <=> $1::vector LIMIT 3',
        [toVectorLiteral(query)],
      );
    });
    // axis0 is exact (distance 0), near0 is next (cosine ~0.006), and axis1 and axis2 tie at distance 1.
    expect(rows.map((r) => r.id).slice(0, 2)).toEqual([ids.axis0, ids.near0]);
    expect([ids.axis1, ids.axis2]).toContain(rows[2]?.id);
  });

  it('the cosine ordering ignores vector magnitude (a scaled vector is equally near)', async () => {
    const scaled = await insert(tenant, axisVector(2, 50));
    const { rows } = await handle.withTenant(tenant, (tx) =>
      tx.query<{ id: string }>(
        'SELECT id FROM vector_probe ORDER BY embedding <=> $1::vector LIMIT 1',
        [toVectorLiteral(axisVector(2))],
      ),
    );
    expect([ids.axis2, scaled]).toContain(rows[0]?.id);
  });

  it('applies the search limit: a LIMIT of 2 returns exactly two rows', async () => {
    const { rows } = await handle.withTenant(tenant, (tx) =>
      tx.query<{ id: string }>(
        'SELECT id FROM vector_probe ORDER BY embedding <=> $1::vector LIMIT 2',
        [toVectorLiteral(axisVector(0))],
      ),
    );
    expect(rows).toHaveLength(2);
  });

  it('is tenant-scoped: another tenant sees no neighbours of its own query', async () => {
    const { rows } = await handle.withTenant(tenantB, (tx) =>
      tx.query<{ id: string }>(
        'SELECT id FROM vector_probe ORDER BY embedding <=> $1::vector LIMIT 10',
        [toVectorLiteral(axisVector(0))],
      ),
    );
    expect(rows).toEqual([]);
  });
});

describe('dimension validation', () => {
  it('the boundary rejects a 3-dimensional vector before anything is written', () => {
    expect(() => parseEmbedding([0.1, 0.2, 0.3])).toThrow(ValidationError);
    expect(() => parseEmbedding([0.1, 0.2, 0.3])).toThrow('vector_dim_mismatch');
  });

  it('the database also rejects a wrong-length vector (defence in depth)', async () => {
    await expect(insert(tenantA, [0.1, 0.2, 0.3])).rejects.toThrow(/dimensions/u);
  });

  it('a wrong-length query is rejected before it reaches the database', () => {
    expect(() => embeddingDistance(probe.embedding, [0.1, 0.2, 0.3])).toThrow(
      'vector_dim_mismatch',
    );
  });
});

describe('tenant isolation of embeddings (RLS)', () => {
  it("tenant B cannot read tenant A's embedding", async () => {
    const id = await insert(tenantA, axisVector(5));
    const visible = await handle.withTenant(tenantB, (tx) =>
      tx.query('SELECT id FROM vector_probe WHERE id = $1', [id]),
    );
    expect(visible.rows).toHaveLength(0);
  });

  it('tenant B cannot write an embedding into tenant A', async () => {
    // Positive control: the same insert succeeds as tenant A, so the rejection below is not vacuous.
    await expect(insert(tenantA, axisVector(7))).resolves.toEqual(expect.any(String));
    await expect(
      handle.withTenant(tenantB, (tx) =>
        tx.query('INSERT INTO vector_probe (tenant_id, embedding) VALUES ($1, $2::vector)', [
          tenantA,
          toVectorLiteral(axisVector(7)),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
