import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { toAuditSqlTx } from './audit-tx.js';

import type { TenantTx } from '@blackwing/db';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();

function fakeTx(rows: Record<string, unknown>[] = []) {
  const seen: { text: string; params: unknown[] }[] = [];
  const tx = {
    execute: (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      seen.push({ text: sql, params });
      return Promise.resolve({ rows });
    },
  } as unknown as TenantTx;
  return { tx, seen };
}

describe('toAuditSqlTx', () => {
  it('binds every $n placeholder as a parameter, in order, and returns the rows', async () => {
    const { tx, seen } = fakeTx([{ head_seq: 3 }]);
    const result = await toAuditSqlTx(tx).query(
      'SELECT * FROM bw_audit_chain_head($1) WHERE x = $2::jsonb AND y = $1',
      ['t', '{"a":1}'],
    );
    expect(result.rows).toEqual([{ head_seq: 3 }]);
    expect(seen[0]?.text).toBe(
      'SELECT * FROM bw_audit_chain_head($1) WHERE x = $2::jsonb AND y = $3',
    );
    expect(seen[0]?.params).toEqual(['t', '{"a":1}', 't']);
  });

  it('never inlines a value into the statement text', async () => {
    const { tx, seen } = fakeTx();
    await toAuditSqlTx(tx).query('SELECT $1', ["'; DROP TABLE audit_events; --"]);
    expect(seen[0]?.text).toBe('SELECT $1');
  });

  it('runs a statement without parameters', async () => {
    const { tx, seen } = fakeTx();
    await toAuditSqlTx(tx).query('SELECT 1');
    expect(seen[0]).toEqual({ text: 'SELECT 1', params: [] });
  });

  it('fails when a placeholder has no value', async () => {
    const { tx } = fakeTx();
    await expect(toAuditSqlTx(tx).query('SELECT $2', ['only-one'])).rejects.toThrow(RangeError);
  });
});
