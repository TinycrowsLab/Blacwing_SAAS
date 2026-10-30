// Reversal journal persistence (REVERSAL-001, F20, CONTEXT_PACK §7, §8.3, §8.6, §8.8). The journal entry is the
// precondition for a `state_changing` action, so it is written inside the caller's tenant transaction (`withTenant`):
// RLS confines every row, a missing tenant context fails closed, and a foreign run or case is `NotFoundError`.
// The methods take the transaction as their first argument, so one unit of work can journal an action and run it.
//
// The undo status moves only along `UNDO_TRANSITIONS` (`@blackwing/domain`). A status write is guarded by the
// `updated_at` the caller read the entry at: a writer that lost a race, or that holds a stale copy, gets
// `PreconditionFailedError` (412) and nothing changes, so a late writer can never reopen an `undone` entry.

import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  isoDateTimeSchema,
  type ReversalJournalCreate,
  reversalJournalCreateSchema,
  reversalJournalEntrySchema,
  type ReversalUndoStatus,
  reversalUndoStatusSchema,
} from '@blackwing/contracts';
import {
  assertUndoStatusTransition,
  type ReversalJournalEntry,
  undoAttemptsAfter,
} from '@blackwing/domain';
import { NotFoundError, PreconditionFailedError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { publicId } from './columns.js';
import { toTenantIsolationError } from './rls.js';
import { reversalJournalEntries, type ReversalJournalEntryRow } from './schema/reversal-journal.js';
import { type TenantTx, unwrapQueryError } from './with-tenant.js';

/** `expectedUpdatedAt` of a status write: the `updatedAt` (ISO-8601) the caller read the entry at. */
const undoStatusMetaSchema = z.strictObject({ expectedUpdatedAt: isoDateTimeSchema });
export type UndoStatusMeta = z.input<typeof undoStatusMetaSchema>;

const idSchema = z.uuid();
const listOptionsSchema = z.strictObject({ status: reversalUndoStatusSchema.optional() });
export type ReversalJournalListOptions = z.input<typeof listOptionsSchema>;

const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/** Field paths only: issue messages can echo input values. */
function parseInput<V>(schema: z.ZodType<V>, value: unknown, what: string): V {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ValidationError(`invalid ${what}`, {
      detail: `Invalid ${what}: ${[...new Set(fields)].join(', ')}.`,
    });
  }
  return result.data;
}

/** Maps a stored row to the domain entry, and re-validates it (a corrupt row fails closed, never leaks). */
function toEntry(row: ReversalJournalEntryRow): ReversalJournalEntry {
  return reversalJournalEntrySchema.parse({
    id: row.id,
    publicId: row.publicId,
    tenantId: row.tenantId,
    runId: row.runId,
    testCaseId: row.testCaseId,
    subtaskId: row.subtaskId,
    action: row.action,
    target: row.target,
    intrusivenessClass: row.intrusivenessClass,
    undoInstructions: row.undoInstructions,
    undoStatus: row.undoStatus,
    undoAttempts: row.undoAttempts,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Runs `run` in a `db.reversal_journal.<op>` span carrying the run and undo status (never the payloads). */
function journalSpan<T>(
  op: string,
  attributes: Readonly<Record<string, string>>,
  run: () => Promise<T>,
): Promise<T> {
  return trace
    .getTracer('@blackwing/db')
    .startActiveSpan(`db.reversal_journal.${op}`, async (span: Span) => {
      for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
      try {
        return await run();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}

/** A CHECK violation is a validation error; a missing run or case is `NotFoundError` (§8.6: never say which). */
function translate(error: unknown): unknown {
  const pgError = unwrapQueryError(error) as { code?: unknown };
  if (pgError.code === CHECK_VIOLATION) {
    return new ValidationError('invalid reversal journal entry', {
      detail: 'A database check rejected the reversal journal entry.',
      cause: error,
    });
  }
  if (pgError.code === FOREIGN_KEY_VIOLATION) {
    return new NotFoundError('run or test case not found', { cause: error });
  }
  return toTenantIsolationError(pgError) ?? error;
}

/**
 * Journals one `state_changing` action before it runs. `entry` is parsed with `reversalJournalCreateSchema` (NFC,
 * the 16 KiB cap and the typed undo descriptor). The row starts `pending` with zero attempts.
 */
async function create(tx: TenantTx, entry: unknown): Promise<ReversalJournalEntry> {
  const values: ReversalJournalCreate = parseInput(
    reversalJournalCreateSchema,
    entry,
    'reversal journal entry',
  );
  const id = newId();
  return journalSpan('create', { run_id: values.runId, undo_status: 'pending' }, async () => {
    try {
      const [row] = await tx
        .insert(reversalJournalEntries)
        .values({
          id,
          publicId: publicId('rvj', id),
          tenantId: values.tenantId,
          runId: values.runId,
          testCaseId: values.testCaseId,
          subtaskId: values.subtaskId ?? null,
          action: values.action,
          target: values.target,
          undoInstructions: values.undoInstructions,
        })
        .returning();
      if (row === undefined) throw new Error('reversal journal insert returned no row');
      return toEntry(row);
    } catch (error) {
      throw translate(error);
    }
  });
}

/** One entry of the tenant, or `null` when it does not exist there (RLS hides another tenant's entry). */
async function getById(tx: TenantTx, id: unknown): Promise<ReversalJournalEntry | null> {
  const key = parseInput(idSchema, id, 'reversal journal entry id');
  const [row] = await tx
    .select()
    .from(reversalJournalEntries)
    .where(eq(reversalJournalEntries.id, key))
    .limit(1);
  return row === undefined ? null : toEntry(row);
}

/** The entries of one run, oldest first, optionally only those in one undo status. */
async function listByRun(
  tx: TenantTx,
  runId: unknown,
  options: ReversalJournalListOptions = {},
): Promise<readonly ReversalJournalEntry[]> {
  const run = parseInput(idSchema, runId, 'run id');
  const { status } = parseInput(listOptionsSchema, options, 'reversal journal filter');
  const rows = await tx
    .select()
    .from(reversalJournalEntries)
    .where(
      and(
        eq(reversalJournalEntries.runId, run),
        status === undefined ? undefined : eq(reversalJournalEntries.undoStatus, status),
      ),
    )
    .orderBy(asc(reversalJournalEntries.createdAt), asc(reversalJournalEntries.id));
  return rows.map((row) => toEntry(row));
}

/**
 * Moves an entry's undo status. An unknown status is a `ValidationError`, and a move the current status forbids is a
 * `ConflictError` (409), both before any write. The write itself is guarded by `expectedUpdatedAt` and the status it
 * was read in: a concurrent change makes it `PreconditionFailedError` (412). Entering `undone` or `failed` counts an
 * undo attempt, and entering `undone` stamps `undone_at` from the database clock.
 */
async function setUndoStatus(
  tx: TenantTx,
  id: unknown,
  status: unknown,
  meta: UndoStatusMeta,
): Promise<ReversalJournalEntry> {
  const key = parseInput(idSchema, id, 'reversal journal entry id');
  const next: ReversalUndoStatus = parseInput(reversalUndoStatusSchema, status, 'undo status');
  const { expectedUpdatedAt } = parseInput(undoStatusMetaSchema, meta, 'undo status update');
  return journalSpan('set_undo_status', { undo_status: next }, async () => {
    const [current] = await tx
      .select()
      .from(reversalJournalEntries)
      .where(eq(reversalJournalEntries.id, key))
      .limit(1);
    if (current === undefined) throw new NotFoundError('reversal journal entry not found');
    assertUndoStatusTransition(current.undoStatus, next);
    try {
      // The row is matched on the status and `updated_at` the caller read. The trigger bumps `updated_at` on every
      // write, so a stale or concurrent writer matches nothing. The timestamp compares at millisecond precision,
      // the precision `updatedAt` carries on the wire.
      const [row] = await tx
        .update(reversalJournalEntries)
        .set({
          undoStatus: next,
          undoAttempts: undoAttemptsAfter(current.undoAttempts, next),
          undoneAt: next === 'undone' ? sql`now()` : null,
        })
        .where(
          and(
            eq(reversalJournalEntries.id, key),
            eq(reversalJournalEntries.undoStatus, current.undoStatus),
            sql`date_trunc('milliseconds', ${reversalJournalEntries.updatedAt}) = ${new Date(expectedUpdatedAt)}`,
          ),
        )
        .returning();
      if (row === undefined) {
        throw new PreconditionFailedError('reversal journal entry changed since it was read', {
          detail: 'Re-read the entry and retry the status update.',
        });
      }
      return toEntry(row);
    } catch (error) {
      if (error instanceof PreconditionFailedError) throw error;
      throw translate(error);
    }
  });
}

/** The reversal journal's tenant-scoped persistence. Every method takes the `withTenant` transaction. */
export const reversalJournalRepository = Object.freeze({
  create,
  getById,
  listByRun,
  setUndoStatus,
});
