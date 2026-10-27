import { sql, type SQL } from 'drizzle-orm';

import type { AuditSqlTx } from '@blackwing/audit';
import type { TenantTx } from '@blackwing/db';

const PLACEHOLDER = /\$(\d+)/g;

/** Splits `text` at its `$n` placeholders into a Drizzle `sql` with bound parameters (never interpolated). */
function toSql(text: string, values: readonly unknown[]): SQL {
  const chunks: SQL[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const index = Number(match[1]) - 1;
    if (!(index in values)) throw new RangeError(`missing value for placeholder ${match[0]}`);
    chunks.push(sql.raw(text.slice(last, match.index)), sql`${values[index]}`);
    last = match.index + match[0].length;
  }
  chunks.push(sql.raw(text.slice(last)));
  return sql.join(chunks, sql.raw(''));
}

/**
 * Runs the audit package's parameterised SQL on a `withTenant` transaction, so the chain append joins
 * that transaction (tenant context set, RLS in force) without opening a connection of its own.
 */
export function toAuditSqlTx(tx: TenantTx): AuditSqlTx {
  return {
    async query(text, values = []) {
      const result = await tx.execute(toSql(text, values));
      return { rows: result.rows };
    },
  };
}
