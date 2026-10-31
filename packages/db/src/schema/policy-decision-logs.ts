import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { idColumn, tenantIdColumn, tenantIdIndex } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';

/**
 * Policy decision log (POLICY-004, CONTEXT_PACK §8.7, §8.11). One row per logged PDP decision: ids,
 * the decision, the determining policy ids and a SHA-256 digest of the canonical context. The raw
 * context and any secret are never stored, so a decision can be replayed from the digest and `now_utc`
 * without the data itself. Denials and evaluation errors are always written; allows follow the
 * configured log mode. The table is append-only and tenant-scoped. The forward-only migration in
 * `migrations/` is generated from this file (`pnpm db:generate`) and then reviewed; FORCE ROW LEVEL
 * SECURITY and the grants are appended by hand because Drizzle does not model them.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const policyDecisionLogs = pgTable(
  'policy_decision_logs',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    /** The run the decision was made for, when the caller named one. */
    runId: uuid('run_id'),
    /** `<action type>::<action id>`, for example `Egress::Action::httpRequest`. */
    action: text('action').notNull(),
    decision: text('decision').notNull(),
    /** Ids of the policies that determined the decision (baseline ids included). */
    determiningPolicyIds: text('determining_policy_ids').array().notNull(),
    errored: boolean('errored').notNull().default(false),
    latencyMs: integer('latency_ms').notNull(),
    /** SHA-256 (hex) over the canonical context. The context itself is never stored. */
    contextDigest: text('context_digest').notNull(),
    /** The explicit decision time the engine was given (ISO-8601 UTC). */
    nowUtc: ts('now_utc').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    tenantIdIndex('policy_decision_logs', t.tenantId),
    index('policy_decision_logs_tenant_created_idx').on(t.tenantId, t.createdAt),
    check('policy_decision_logs_decision_check', sql`${t.decision} IN ('allow', 'deny')`),
    check('policy_decision_logs_latency_check', sql`${t.latencyMs} >= 0`),
    check('policy_decision_logs_digest_check', sql`${t.contextDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'policy_decision_logs_errored_deny_check',
      sql`NOT ${t.errored} OR ${t.decision} = 'deny'`,
    ),
    pgPolicy('policy_decision_logs_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type PolicyDecisionLogRow = typeof policyDecisionLogs.$inferSelect;
export type NewPolicyDecisionLogRow = typeof policyDecisionLogs.$inferInsert;
