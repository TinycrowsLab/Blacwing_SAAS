// vector: unit tests for the pgvector helpers (DB-005). Table and index shape, the boundary validation and
// the SQL text. Database behaviour (extension, ANN ordering) is in vector.int.test.ts.

import { type ExtraConfigColumn, getTableConfig, pgTable, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { idColumn, tenantIdColumn, tenantIdIndex } from './columns.js';
import {
  EMBEDDING_DIMENSIONS,
  embeddingColumn,
  embeddingDistance,
  embeddingSchema,
  HNSW_EF_CONSTRUCTION,
  HNSW_EF_SEARCH,
  HNSW_M,
  hnswEfSearchSql,
  hnswIndex,
  parseEmbedding,
  toVectorLiteral,
} from './vector.js';

const memories = pgTable(
  'memories',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    embedding: embeddingColumn(),
    label: embeddingColumn('label_embedding'),
  },
  (t) => [tenantIdIndex('memories', t.tenantId), hnswIndex('memories', t.embedding)],
);

const dialect = new PgDialect();
const vectorOf = (length: number, value = 0.5) => Array.from({ length }, () => value);

/**
 * The vector column as `extraConfig` receives it (`t.embedding`), for calling `hnswIndex` directly. Drizzle
 * evaluates `extraConfig` lazily, so the table config is read to trigger it.
 */
function extraColumn(tableName: string, columnName: string): ExtraConfigColumn {
  let found: ExtraConfigColumn | undefined;
  const table = pgTable(tableName, { embedding: embeddingColumn(columnName) }, (t) => {
    found = t.embedding;
    return [];
  });
  getTableConfig(table);
  if (!found) throw new Error('extraConfig did not run');
  return found;
}

/** The error `fn` throws, or `undefined` when it returns normally. */
function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The operator class of an index column (drizzle keeps it on `indexConfig`). */
function opClassOf(column: unknown): unknown {
  return (column as { indexConfig?: { opClass?: unknown } } | undefined)?.indexConfig?.opClass;
}

describe('EMBEDDING_DIMENSIONS and HNSW defaults', () => {
  it('match the bge-small-en-v1.5 model and the documented HNSW defaults', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(384);
    expect(HNSW_M).toBe(16);
    expect(HNSW_EF_CONSTRUCTION).toBe(64);
    expect(HNSW_EF_SEARCH).toBe(40);
  });
});

describe('embeddingColumn', () => {
  it('is a vector(384) column named "embedding" by default', () => {
    const column = getTableConfig(memories).columns.find((c) => c.name === 'embedding');
    expect(column).toBeDefined();
    expect(column?.getSQLType()).toBe('vector(384)');
    expect(column?.notNull).toBe(false);
  });

  it('takes a custom column name', () => {
    const column = getTableConfig(memories).columns.find((c) => c.name === 'label_embedding');
    expect(column?.getSQLType()).toBe('vector(384)');
  });
});

describe('hnswIndex', () => {
  const index = () => {
    const found = getTableConfig(memories).indexes.find((i) =>
      i.config.name?.endsWith('_hnsw_idx'),
    );
    if (!found) throw new Error('missing hnsw index');
    return found.config;
  };

  it('builds an hnsw index with cosine ops and m=16, ef_construction=64 by default', () => {
    const config = index();
    expect(config.name).toBe('memories_embedding_hnsw_idx');
    expect(config.method).toBe('hnsw');
    expect(config.with).toEqual({ m: 16, ef_construction: 64 });
    expect(config.columns).toHaveLength(1);
    expect(opClassOf(config.columns[0])).toBe('vector_cosine_ops');
  });

  it('couples an L2 index to vector_l2_ops when asked for the l2 metric', () => {
    const l2 = pgTable('l2_items', { embedding: embeddingColumn() }, (t) => [
      hnswIndex('l2_items', t.embedding, { distance: 'l2' }),
    ]);
    const [index] = getTableConfig(l2).indexes;
    expect(opClassOf(index?.config.columns[0])).toBe('vector_l2_ops');
  });

  it('rejects a table name that is not a safe SQL identifier', () => {
    const column = extraColumn('memories', 'embedding');
    expect(() => hnswIndex('Memories; DROP TABLE x', column)).toThrow(TypeError);
    expect(() => hnswIndex('1memories', column)).toThrow(TypeError);
  });

  it('rejects an index name longer than the 63-byte Postgres identifier limit', () => {
    const column = extraColumn('t'.repeat(40), 'e'.repeat(40));
    expect(() => hnswIndex('t'.repeat(40), column)).toThrow(TypeError);
  });
});

describe('parseEmbedding (boundary)', () => {
  it('accepts exactly 384 finite numbers and returns them unchanged', () => {
    const input = vectorOf(EMBEDDING_DIMENSIONS, 0.25);
    expect(parseEmbedding(input)).toEqual(input);
    expect(embeddingSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['too short', 383],
    ['too long', 385],
    ['empty', 0],
    ['a single value', 1],
  ])('rejects a %s vector as vector_dim_mismatch', (_name, length) => {
    let caught: unknown;
    try {
      parseEmbedding(vectorOf(length));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toBe('vector_dim_mismatch');
    expect((caught as ValidationError).code).toBe('VALIDATION_FAILED');
    expect((caught as ValidationError).httpStatus).toBe(422);
    // The client detail names the expected size and never echoes the values.
    expect((caught as ValidationError).detail).toBe('An embedding must have 384 dimensions.');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a string', '0.5'],
    ['null', null],
  ])('rejects a non-finite or non-numeric value (%s) as vector_invalid', (_name, value) => {
    const input = vectorOf(EMBEDDING_DIMENSIONS);
    input[10] = value as number;
    expect(() => parseEmbedding(input)).toThrow(ValidationError);
    expect(() => parseEmbedding(input)).toThrow('vector_invalid');
  });

  it.each([
    ['undefined', undefined],
    ['an object', { length: 384 }],
    ['a string', 'x'.repeat(384)],
    ['a number', 384],
  ])('rejects %s', (_name, input) => {
    expect(() => parseEmbedding(input)).toThrow(ValidationError);
  });

  it('never leaks the offending values into the client detail', () => {
    const input = vectorOf(EMBEDDING_DIMENSIONS);
    input[0] = 0.123456789;
    input[1] = Number.NaN;
    const error = errorOf(() => parseEmbedding(input));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).not.toContain('0.123456789');
  });
});

describe('embeddingDistance', () => {
  const query = vectorOf(EMBEDDING_DIMENSIONS, 0.5);

  it('renders the cosine operator <=> against a vector literal by default', () => {
    const { sql, params } = dialect.sqlToQuery(embeddingDistance(memories.embedding, query));
    expect(sql).toContain('<=>');
    expect(sql).toMatch(/::vector$/u);
    expect(params).toEqual([toVectorLiteral(query)]);
  });

  it('uses the L2 operator <-> for the l2 metric', () => {
    const { sql } = dialect.sqlToQuery(embeddingDistance(memories.embedding, query, 'l2'));
    expect(sql).toContain('<->');
    expect(sql).not.toContain('<=>');
  });

  it('validates the query vector before any SQL is built', () => {
    expect(() => embeddingDistance(memories.embedding, vectorOf(3))).toThrow('vector_dim_mismatch');
  });
});

describe('toVectorLiteral', () => {
  it('formats the pgvector text form [a,b,c]', () => {
    expect(toVectorLiteral([0.5, -1, 2e-7])).toBe('[0.5,-1,2e-7]');
  });
});

describe('hnswEfSearchSql', () => {
  it('defaults to ef_search 40, set locally to the transaction', () => {
    expect(hnswEfSearchSql()).toBe('SET LOCAL hnsw.ef_search = 40');
  });

  it('accepts the pgvector range 1 to 1000', () => {
    expect(hnswEfSearchSql(1)).toBe('SET LOCAL hnsw.ef_search = 1');
    expect(hnswEfSearchSql(1000)).toBe('SET LOCAL hnsw.ef_search = 1000');
  });

  it.each([0, 1001, -5, 40.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s, which is not a valid ef_search',
    (value) => {
      expect(() => hnswEfSearchSql(value)).toThrow(RangeError);
    },
  );
});
