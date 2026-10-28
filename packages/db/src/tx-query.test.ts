import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { positionalSql, txQuery } from './tx-query.js';

import type { Tx } from './client.js';

const dialect = new PgDialect();

/** Renders the SQL a fake transaction received, so the bound SQL and its parameters can be checked. */
function renderedBy(
  run: (tx: Tx) => Promise<unknown>,
): Promise<{ sql: string; params: unknown[] }> {
  let captured: { sql: string; params: unknown[] } | undefined;
  const fake = {
    execute: (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      captured = dialect.sqlToQuery(query);
      return Promise.resolve({ rows: [{ seq: 1 }] });
    },
  } as unknown as Tx;
  return run(fake).then(() => {
    if (captured === undefined) throw new Error('nothing was executed');
    return captured;
  });
}

describe('positionalSql', () => {
  it('binds each $n as a parameter and keeps the literal text', () => {
    const { sql, params } = dialect.sqlToQuery(
      positionalSql('SELECT $1::text, $2::int, $1::text', ['a', 7]),
    );
    expect(sql).toBe('SELECT $1::text, $2::int, $3::text');
    expect(params).toEqual(['a', 7, 'a']);
  });

  it('passes text without placeholders through unchanged', () => {
    expect(dialect.sqlToQuery(positionalSql('SELECT now()')).sql).toBe('SELECT now()');
  });

  it('refuses a placeholder with no bound value', () => {
    expect(() => positionalSql('SELECT $2', ['only-one'])).toThrow(
      'placeholder $2 has no bound value',
    );
    expect(() => positionalSql('SELECT $1')).toThrow('placeholder $1 has no bound value');
  });

  it('never splices a bound value into the SQL text', () => {
    const hostile = "x'); DROP TABLE audit_events; --";
    const { sql, params } = dialect.sqlToQuery(positionalSql('SELECT $1', [hostile]));
    expect(sql).not.toContain('DROP');
    expect(params).toEqual([hostile]);
  });
});

describe('txQuery', () => {
  it('runs the query through the transaction and returns its rows', async () => {
    const adapter = txQuery({
      execute: () => Promise.resolve({ rows: [{ seq: 1 }] }),
    } as unknown as Tx);
    await expect(adapter.query('SELECT 1')).resolves.toEqual({ rows: [{ seq: 1 }] });
  });

  it('binds values as parameters', async () => {
    const got = await renderedBy((tx) => txQuery(tx).query('SELECT $1::text', ['v']));
    expect(got.sql).toBe('SELECT $1::text');
    expect(got.params).toEqual(['v']);
  });
});
