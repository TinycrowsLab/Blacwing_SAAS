import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  unique,
} from 'drizzle-orm/pg-core';

import { TENANT_PREDICATE } from './columns.js';

/**
 * Human and system decisions at the run gates (CONTEXT_PACK §4.2, §4.3, F13). One row per decision. Gate 2
 * (runtime exception) rows are opened by the execution phase for a deferred out-of-envelope tool call and for a
 * `request_scope_exception`. A row is decided once: `status` moves from `pending` to `approved` or `denied`
 * and never back. No decision before `timeout_at` is denied by the system (`auto = true`, F13).
 *
 * The forward-only migration is generated from this file (`pnpm db:generate`) and then reviewed; FORCE ROW
 * LEVEL SECURITY and the grants are appended by hand because Drizzle does not model them.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Mirrors `GATE_DECISION_KINDS` in the worker's execution types. The worker test asserts the two stay equal. */
export const GATE_DECISION_KINDS = ['tool_deferred', 'scope_exception'] as const;
/** Mirrors `GATE_DECISION_STATUSES`: the lifecycle of one row. */
export const GATE_DECISION_STATUSES = ['pending', 'approved', 'denied'] as const;

export const gateDecisions = pgTable(
  'gate_decisions',
  {
    decisionId: uuid('decision_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    runId: uuid('run_id').notNull(),
    /** Gate number: 1 scope, 2 runtime exception, 3 release. Only 2 is written by the execution phase. */
    gate: integer('gate').notNull(),
    kind: text('kind').notNull(),
    /** Idempotency key chosen by the opener; a second open with the same key returns the existing row. */
    dedupeKey: text('dedupe_key').notNull(),
    subtaskId: text('subtask_id'),
    sessionId: text('session_id'),
    toolUseId: text('tool_use_id'),
    /** Sanitised, truncated description of the request. Untrusted text, shown to the approver as data. */
    summary: text('summary').notNull(),
    /** Scope exceptions only: the requested target. */
    target: text('target'),
    status: text('status').notNull().default('pending'),
    requestedAt: ts('requested_at').notNull(),
    timeoutAt: ts('timeout_at').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    reason: text('reason'),
    auto: boolean('auto').notNull().default(false),
  },
  (t) => [
    unique('gate_decisions_tenant_dedupe_key').on(t.tenantId, t.dedupeKey),
    check('gate_decisions_gate_check', sql`${t.gate} BETWEEN 1 AND 3`),
    check(
      'gate_decisions_kind_check',
      sql`${t.kind} IN (${sql.raw(GATE_DECISION_KINDS.map((v) => `'${v}'`).join(', '))})`,
    ),
    check(
      'gate_decisions_status_check',
      sql`${t.status} IN (${sql.raw(GATE_DECISION_STATUSES.map((v) => `'${v}'`).join(', '))})`,
    ),
    // A decided row carries who or what decided it and when; a pending row carries neither.
    check(
      'gate_decisions_decided_check',
      sql`(${t.status} = 'pending' AND ${t.decidedAt} IS NULL AND ${t.decidedBy} IS NULL AND ${t.auto} = false)
        OR (${t.status} <> 'pending' AND ${t.decidedAt} IS NOT NULL AND (${t.decidedBy} IS NOT NULL OR ${t.auto} = true))`,
    ),
    // The canonical tenant policy (`rlsPolicySql` shape): no TO clause, access is granted to bw_app only.
    pgPolicy('gate_decisions_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type GateDecisionRow = typeof gateDecisions.$inferSelect;
export type NewGateDecisionRow = typeof gateDecisions.$inferInsert;
