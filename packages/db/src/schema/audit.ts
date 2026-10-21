import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  AUDIT_GENESIS_PREV_HASH,
  type AuditActor,
  type AuditMetadata,
  type AuditMetadataRef,
  type AuditOutcome,
  type AuditSeverity,
  type AuditTarget,
} from '@blackwing/contracts';

import { bytea, TENANT_PREDICATE } from './columns.js';

/**
 * The audit ledger (AUDIT-002, F34, CONTEXT_PACK §7, §8.6, §8.8): one append-only hash chain per
 * tenant. Schema only; the TypeScript insert helper is AUDIT-003 and checkpoints are AUDIT-004.
 *
 * WRITES MUST GO THROUGH THE AUDIT-003 HELPER, never a raw insert. The helper takes the per-tenant
 * advisory lock (`bw_audit_chain_head`), reads the chain head, computes `hash` over the JCS form of
 * the event and inserts in the same transaction. The database enforces the rest regardless of the
 * caller: a `BEFORE INSERT` trigger rejects any row whose `seq` / `prev_hash` do not extend the
 * tenant's chain, and `audit_events_no_mutate` rejects UPDATE, DELETE and TRUNCATE for every role.
 * The grant to the app role is SELECT and INSERT only.
 *
 * Hash, as AUDIT-001 defines it: `hash = SHA-256(utf8(JCS(event without hash)))`. The hashed event
 * carries `prevHash` (hex) and `seq`, so `hash_n` depends on `hash_{n-1}`. The contract spells the
 * genesis `prevHash` as {@link AUDIT_GENESIS_PREV_HASH_HEX}; the table stores `prev_hash = NULL` for
 * it (and only for `seq = 1`), so verification maps NULL to that constant and any other value to the
 * lowercase hex of the stored bytes. The migration in
 * `migrations/` is generated from this file and the trigger/grant part is appended by hand.
 */

/** Genesis `prev_hash` as the AUDIT-001 contract spells it; stored as NULL on the `seq = 1` row. */
export const AUDIT_GENESIS_PREV_HASH_HEX = AUDIT_GENESIS_PREV_HASH;

const SEVERITIES = [
  'info',
  'notice',
  'warning',
  'critical',
] as const satisfies readonly AuditSeverity[];
const OUTCOMES = ['success', 'failure', 'denied'] as const satisfies readonly AuditOutcome[];

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

export const auditEvents = pgTable(
  'audit_events',
  {
    /** The event id (UUIDv7, assigned by the producer and covered by `hash`). */
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    /** 1-based position in the tenant's chain; gapless, assigned under the advisory lock. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** Producer wall time; informational (ordering is `seq`). */
    occurredAt: ts('occurred_at').notNull(),
    action: text('action').notNull(),
    severity: text('severity', { enum: SEVERITIES }).notNull(),
    actor: jsonb('actor').$type<AuditActor>().notNull(),
    target: jsonb('target').$type<AuditTarget>().notNull(),
    outcome: text('outcome', { enum: OUTCOMES }).notNull(),
    reason: text('reason'),
    /** Redacted by the producer before the event is built (§8.7); at most 16 KiB canonical JSON. */
    metadata: jsonb('metadata').$type<AuditMetadata>().notNull().default({}),
    metadataRef: jsonb('metadata_ref').$type<AuditMetadataRef>(),
    traceId: text('trace_id'),
    runId: uuid('run_id'),
    /** Kept as text (not inet) so the stored spelling is byte-identical to what was hashed. */
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Previous row's `hash`; NULL only on the genesis row (`seq = 1`). */
    prevHash: bytea('prev_hash'),
    /** SHA-256 chain hash (32 bytes). */
    hash: bytea('hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('audit_events_tenant_seq_key').on(t.tenantId, t.seq),
    index('audit_events_tenant_occurred_at_idx').on(t.tenantId, t.occurredAt),
    index('audit_events_tenant_action_idx').on(t.tenantId, t.action),
    index('audit_events_run_id_idx').on(t.runId),
    check('audit_events_seq_check', sql`${t.seq} >= 1`),
    check('audit_events_severity_check', sql`${t.severity} IN (${inList(SEVERITIES)})`),
    check('audit_events_outcome_check', sql`${t.outcome} IN (${inList(OUTCOMES)})`),
    check('audit_events_hash_length_check', sql`octet_length(${t.hash}) = 32`),
    check(
      'audit_events_prev_hash_check',
      sql`(${t.seq} = 1) = (${t.prevHash} IS NULL) AND (${t.prevHash} IS NULL OR octet_length(${t.prevHash}) = 32)`,
    ),
    check('audit_events_actor_check', sql`jsonb_typeof(${t.actor}) = 'object'`),
    check('audit_events_target_check', sql`jsonb_typeof(${t.target}) = 'object'`),
    check('audit_events_metadata_check', sql`jsonb_typeof(${t.metadata}) = 'object'`),
    pgPolicy('audit_events_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
