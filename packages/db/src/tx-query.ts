// Adapts a Drizzle transaction to the raw `query(text, values)` shape that `@blackwing/audit` writes with, so
// an audit event can be appended in the same transaction as the change it records (§8.8). The SQL text comes
// from the audit package's own statements and is never built from input; values are bound as parameters.

import { sql, type SQL } from 'drizzle-orm';

import type { Tx } from './client.js';

/** Positional placeholders `$1`, `$2`, ... in the text, which Drizzle binds as parameters. */
const PLACEHOLDER = /\$(\d+)/;

export interface TxQueryResult {
  readonly rows: Record<string, unknown>[];
}

/** Turns `text` with `$n` placeholders into a Drizzle SQL object with bound values. */
export function positionalSql(text: string, values: readonly unknown[] = []): SQL {
  const chunks: SQL[] = [];
  let rest = text;
  let match = PLACEHOLDER.exec(rest);
  while (match !== null) {
    const index = Number(match[1]) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) {
      throw new Error(`placeholder $${String(index + 1)} has no bound value`);
    }
    chunks.push(sql.raw(rest.slice(0, match.index)));
    chunks.push(sql`${values[index]}`);
    rest = rest.slice(match.index + match[0].length);
    match = PLACEHOLDER.exec(rest);
  }
  chunks.push(sql.raw(rest));
  return sql.join(chunks, sql``);
}

/** The raw query handle over a Drizzle transaction, for `@blackwing/audit`'s `AuditSqlTx`. */
export function txQuery(tx: Tx): {
  query(text: string, values?: unknown[]): Promise<TxQueryResult>;
} {
  return {
    async query(text, values) {
      const result = await tx.execute(positionalSql(text, values));
      return { rows: [...result.rows] as Record<string, unknown>[] };
    },
  };
}
