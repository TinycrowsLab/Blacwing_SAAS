import { sql, type SQL } from 'drizzle-orm';

import type { AuditSqlTx } from '@blackwing/audit';
import type { Tx } from '@blackwing/db';

/**
 * Adapts a Drizzle transaction to the audit helper's `query(text, values)` shape, so the hash-chain append
 * runs on the same connection, in the same transaction, as the asset write it records (§8.8: a write whose
 * audit event cannot be stored does not happen). The chain's fixed `$n` markers become bound parameters;
 * values are never spliced into the SQL text.
 */
export function auditSqlTx(tx: Tx): AuditSqlTx {
  return {
    async query(text, values = []) {
      const parts: SQL[] = [];
      let cursor = 0;
      for (const match of text.matchAll(/\$(\d+)/g)) {
        const index = match.index;
        parts.push(sql.raw(text.slice(cursor, index)));
        parts.push(sql`${values[Number(match[1]) - 1]}`);
        cursor = index + match[0].length;
      }
      parts.push(sql.raw(text.slice(cursor)));
      const result = await tx.execute(sql.join(parts, sql.raw('')));
      return { rows: result.rows };
    },
  };
}
