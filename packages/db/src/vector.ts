// pgvector conventions for embeddings and similarity search (DB-005, CONTEXT_PACK §5, §7). Embeddings are
// produced locally by bge-small-en-v1.5, which emits 384 dimensions, so every embedding column is
// vector(384) and every HNSW index uses the operator class that matches the query operator (cosine by
// default). The extension itself is enabled by migration 20261021081012_pgvector_pgcrypto.
//
// Consumers (MEMORY, knowledge search) build tables from these helpers and follow the tenant rules too:
// embeddings can encode tenant content, so an embedding table gets `tenantIdColumn`, `tenantIdIndex` and
// the RLS policy like any other tenant table. Embedding generation itself is out of scope here.
//
// Query-time tuning: `hnsw.ef_search` (default 40) trades recall for latency and is set per transaction with
// `hnswEfSearchSql()`, e.g. inside `withTenant`. `SET LOCAL` keeps the value to that transaction. Index
// build memory: a large HNSW build needs `maintenance_work_mem` headroom (raise it for the session that runs
// the migration; a build on a big table can fail on the default). Slow ANN queries show up in the
// database's slow-query log under `<=>` / `<->`; alerting is deferred to MEMORY.

import { sql, type SQL } from 'drizzle-orm';
import { type ExtraConfigColumn, index, type PgColumn, vector } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { ValidationError } from '@blackwing/errors';

import { assertIdentifier } from './columns.js';

/** Dimensions of every embedding (bge-small-en-v1.5). Changing the model means a new column, not a new value. */
export const EMBEDDING_DIMENSIONS = 384;

/** Default name of the embedding column. */
export const EMBEDDING_COLUMN = 'embedding';

/** HNSW graph degree (`m`). Higher is more recall and more memory. */
export const HNSW_M = 16;

/** HNSW build-time candidate list (`ef_construction`). Higher is a slower build with better recall. */
export const HNSW_EF_CONSTRUCTION = 64;

/** Query-time candidate list (`hnsw.ef_search`). Must be at least the LIMIT of a query; pgvector accepts 1 to 1000. */
export const HNSW_EF_SEARCH = 40;

const EF_SEARCH_MIN = 1;
const EF_SEARCH_MAX = 1000;

/**
 * Each distance metric pairs an index operator class with its query operator. They are coupled here so an
 * index built with one metric is never queried with the other (a cosine index is ignored by an `<->` query).
 */
export const VECTOR_DISTANCE = {
  cosine: { opClass: 'vector_cosine_ops', operator: '<=>' },
  l2: { opClass: 'vector_l2_ops', operator: '<->' },
} as const;

/** A distance metric supported by {@link hnswIndex} and {@link embeddingDistance}. Cosine is the default. */
export type VectorDistance = keyof typeof VECTOR_DISTANCE;

/** The one zod schema for an embedding: an array of finite numbers with exactly {@link EMBEDDING_DIMENSIONS} entries. */
export const embeddingSchema = z.array(z.number()).superRefine((values, ctx) => {
  if (values.length !== EMBEDDING_DIMENSIONS) {
    ctx.addIssue({ code: 'custom', message: 'vector_dim_mismatch' });
  }
});

/**
 * Validates an embedding at the boundary. A wrong length is `ValidationError` `vector_dim_mismatch` (422); a
 * non-numeric or non-finite value is `vector_invalid`. Nothing is written or queried before this passes.
 */
export function parseEmbedding(input: unknown): number[] {
  const parsed = embeddingSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.some((issue) => issue.message === 'vector_dim_mismatch')) {
    throw new ValidationError('vector_dim_mismatch', {
      detail: `An embedding must have ${EMBEDDING_DIMENSIONS} dimensions.`,
    });
  }
  throw new ValidationError('vector_invalid', {
    detail: 'An embedding must be an array of finite numbers.',
  });
}

/** `vector(384)` column, NOT NULL is up to the caller (`.notNull()`). The DB also rejects a wrong length. */
export function embeddingColumn(name: string = EMBEDDING_COLUMN) {
  return vector(name, { dimensions: EMBEDDING_DIMENSIONS });
}

/**
 * HNSW index on an embedding column, for `extraConfig`: `(t) => [hnswIndex('memories', t.embedding)]`. Builds
 * `USING hnsw (<column> vector_cosine_ops) WITH (m = 16, ef_construction = 64)` for the default cosine metric.
 * The table is named by string (as `tenantIdIndex` does) because the extra config runs before the table exists.
 */
export function hnswIndex(
  tableName: string,
  column: ExtraConfigColumn,
  options: { readonly distance?: VectorDistance } = {},
) {
  const { opClass } = VECTOR_DISTANCE[options.distance ?? 'cosine'];
  const name = assertIdentifier(`${tableName}_${column.name}_hnsw_idx`);
  return index(name)
    .using('hnsw', column.op(opClass))
    .with({ m: HNSW_M, ef_construction: HNSW_EF_CONSTRUCTION });
}

/**
 * The distance expression for ordering and thresholds, `<column> <=> '[...]'::vector` for cosine. The query
 * vector is validated first, so a wrong-length query fails at the boundary, not inside the database.
 */
export function embeddingDistance(
  column: PgColumn,
  query: readonly number[],
  distance: VectorDistance = 'cosine',
): SQL {
  const values = parseEmbedding(query);
  const { operator } = VECTOR_DISTANCE[distance];
  return sql`${column} ${sql.raw(operator)} ${toVectorLiteral(values)}::vector`;
}

/** The pgvector text form of a validated embedding, `[0.1,0.2,...]`. */
export function toVectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

/**
 * `SET LOCAL hnsw.ef_search` for the current transaction. Integer-checked before it is spliced into the SQL
 * text (`SET` cannot take a bind parameter). Run it inside the tenant transaction, before the ANN query.
 */
export function hnswEfSearchSql(efSearch: number = HNSW_EF_SEARCH): string {
  if (!Number.isInteger(efSearch) || efSearch < EF_SEARCH_MIN || efSearch > EF_SEARCH_MAX) {
    throw new RangeError(
      `hnsw.ef_search must be an integer from ${EF_SEARCH_MIN} to ${EF_SEARCH_MAX}`,
    );
  }
  return `SET LOCAL hnsw.ef_search = ${efSearch}`;
}
