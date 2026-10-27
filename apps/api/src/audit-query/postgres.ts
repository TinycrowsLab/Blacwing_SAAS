import { and, desc, eq, gte, lte, type SQL, sql } from 'drizzle-orm';

import { type AuditEmitter, createAuditEmitter } from '@blackwing/audit';
import { auditEvents, type Database, toAuditSqlTx, withTenant } from '@blackwing/db';

import type { AuditEventsPlan, AuditQueryStore } from './ports.js';

/** The SQL predicates a plan adds to `audit_events`; every value is a bound parameter. */
function conditions(plan: AuditEventsPlan): SQL[] {
  const { filters } = plan;
  const clauses: SQL[] = [];
  if (filters.actorId !== undefined)
    clauses.push(sql`${auditEvents.actor} ->> 'id' = ${filters.actorId}`);
  if (filters.action !== undefined) clauses.push(eq(auditEvents.action, filters.action));
  if (filters.targetId !== undefined)
    clauses.push(sql`${auditEvents.target} ->> 'id' = ${filters.targetId}`);
  if (filters.runId !== undefined) clauses.push(eq(auditEvents.runId, filters.runId));
  if (filters.outcome !== undefined) clauses.push(eq(auditEvents.outcome, filters.outcome));
  if (filters.from !== undefined) clauses.push(gte(auditEvents.occurredAt, new Date(filters.from)));
  if (filters.to !== undefined) clauses.push(lte(auditEvents.occurredAt, new Date(filters.to)));
  if (plan.before !== undefined) {
    // Row-value comparison matches `ORDER BY occurred_at DESC, seq DESC` exactly: rows strictly older than the cursor.
    clauses.push(
      sql`(${auditEvents.occurredAt}, ${auditEvents.seq}) < (${plan.before.occurredAt.toISOString()}::timestamptz, ${plan.before.seq}::bigint)`,
    );
  }
  return clauses;
}

/**
 * The Postgres audit query store (#86). Every call runs in `withTenant`, so RLS restricts the rows to
 * the caller's tenant, and the `audit.queried` record joins that same transaction through the audit
 * emitter (a failed record rolls the read back).
 */
export function createPgAuditQueryStore(
  db: Database,
  emitter: AuditEmitter = createAuditEmitter(),
): AuditQueryStore {
  return {
    withTenant: (tenantId, fn) =>
      withTenant(db, tenantId, (tx) =>
        fn({
          events: {
            async list(plan) {
              return tx
                .select()
                .from(auditEvents)
                .where(and(...conditions(plan)))
                .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.seq))
                .limit(plan.fetchLimit);
            },
          },
          audit: {
            async queried(input) {
              await emitter.emitAuditInTx(toAuditSqlTx(tx), input);
            },
          },
        }),
      ),
  };
}
