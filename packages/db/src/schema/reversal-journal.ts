import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { REVERSAL_INTRUSIVENESS_CLASS, REVERSAL_UNDO_STATUSES } from '@blackwing/contracts';

import { idColumn, tenantIdColumn, tenantIdIndex, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';
import { runs } from './runs.js';
import { testCases } from './test-plans.js';

/**
 * Reversal journal (REVERSAL-001, F20, CONTEXT_PACK §7, §8.3, §8.6). One row per `state_changing` action, written
 * before the action runs, with the typed undo descriptor REVERSAL-005 executes. Tenant table: the §7 policy comes
 * from `TENANT_PREDICATE`, and composite `(tenant_id, …)` foreign keys stop an entry from naming another tenant's
 * run or case (plain FK checks bypass RLS).
 *
 * Inline `target` and `undo_instructions` are capped at 16 KiB by CHECK, the same bound the Zod contract enforces;
 * a larger payload is stored as evidence and referenced. `subtask_id` has no foreign key yet because the subtasks
 * table lands with the agent-team epic. The migration is generated from this file (`pnpm db:generate`) and then
 * reviewed. FORCE ROW LEVEL SECURITY, the grants and the `updated_at` trigger are appended by hand, since Drizzle
 * models none of them.
 */

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/** Backstop for the inline jsonb payloads: 16 KiB of text, the CONTRACT bound (`REVERSAL_INLINE_MAX_BYTES`). */
const INLINE_MAX_BYTES = sql.raw('16384');

export const reversalJournalEntries = pgTable(
  'reversal_journal_entries',
  {
    id: idColumn(),
    /** The `rvj_…` public id (`publicId('rvj', id)`): stable, carries no PII. */
    publicId: text('public_id').notNull(),
    tenantId: tenantIdColumn(),
    runId: uuid('run_id').notNull(),
    testCaseId: uuid('test_case_id').notNull(),
    /** A subtask of the agent team, when the action came from one. No foreign key yet (see the file comment). */
    subtaskId: uuid('subtask_id'),
    /** The action being journalled, NFC-normalised before it is stored. */
    action: text('action').notNull(),
    /** What the action touches: `{kind, ref, method?, urlTemplate?}` (`reversalTargetSchema`). */
    target: jsonb('target').$type<Record<string, unknown>>().notNull(),
    intrusivenessClass: text('intrusiveness_class').notNull().default(REVERSAL_INTRUSIVENESS_CLASS),
    /** The typed undo descriptor, or an evidence reference (`reversalUndoPayloadSchema`). Never a shell command. */
    undoInstructions: jsonb('undo_instructions').$type<Record<string, unknown>>().notNull(),
    undoStatus: text('undo_status', { enum: REVERSAL_UNDO_STATUSES }).notNull().default('pending'),
    undoAttempts: integer('undo_attempts').notNull().default(0),
    undoneAt: timestamp('undone_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantIdIndex('reversal_journal_entries', t.tenantId),
    index('reversal_journal_entries_tenant_run_idx').on(t.tenantId, t.runId),
    index('reversal_journal_entries_run_undo_status_idx').on(t.runId, t.undoStatus),
    index('reversal_journal_entries_test_case_id_idx').on(t.testCaseId),
    uniqueIndex('reversal_journal_entries_public_id_key').on(t.publicId),
    // Composite foreign keys: an entry can never name another tenant's run or test case.
    foreignKey({
      name: 'reversal_journal_entries_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    foreignKey({
      name: 'reversal_journal_entries_test_case_fk',
      columns: [t.tenantId, t.testCaseId],
      foreignColumns: [testCases.tenantId, testCases.id],
    }),
    check('reversal_journal_entries_public_id_check', sql`starts_with(${t.publicId}, 'rvj_')`),
    check('reversal_journal_entries_action_check', sql`char_length(${t.action}) BETWEEN 1 AND 200`),
    check(
      'reversal_journal_entries_intrusiveness_check',
      sql`${t.intrusivenessClass} = '${sql.raw(REVERSAL_INTRUSIVENESS_CLASS)}'`,
    ),
    check(
      'reversal_journal_entries_undo_status_check',
      sql`${t.undoStatus} IN (${inList(REVERSAL_UNDO_STATUSES)})`,
    ),
    check('reversal_journal_entries_undo_attempts_check', sql`${t.undoAttempts} >= 0`),
    // `undone_at` is set only once the entry is undone.
    check(
      'reversal_journal_entries_undone_at_check',
      sql`${t.undoStatus} = 'undone' OR ${t.undoneAt} IS NULL`,
    ),
    check(
      'reversal_journal_entries_target_object_check',
      sql`jsonb_typeof(${t.target}) = 'object' AND octet_length(${t.target}::text) <= ${INLINE_MAX_BYTES}`,
    ),
    check(
      'reversal_journal_entries_undo_object_check',
      sql`jsonb_typeof(${t.undoInstructions}) = 'object' AND octet_length(${t.undoInstructions}::text) <= ${INLINE_MAX_BYTES}`,
    ),
    pgPolicy('reversal_journal_entries_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type ReversalJournalEntryRow = typeof reversalJournalEntries.$inferSelect;
export type NewReversalJournalEntryRow = typeof reversalJournalEntries.$inferInsert;
