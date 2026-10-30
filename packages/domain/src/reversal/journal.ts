import { ConflictError } from '@blackwing/errors';

import type { ReversalJournalEntryContract, ReversalUndoStatus } from '@blackwing/contracts';

/**
 * Reversal journal state rules (REVERSAL-001, F20, CONTEXT_PACK §7, §8.3). The journal entry is written before a
 * `state_changing` action runs, and its undo lifecycle moves only along {@link UNDO_TRANSITIONS}. The rules are
 * pure and deterministic (§8.11). The repository calls them inside the write's transaction, so a stale or illegal
 * move never reaches the row.
 */

/** A stored journal entry, as the domain sees it. */
export type ReversalJournalEntry = ReversalJournalEntryContract;

/**
 * Allowed undo moves. `undone` and `not_needed` are terminal: once an undo is done or ruled unnecessary it is never
 * reopened, so a late writer cannot turn `undone` back into `pending`. `failed` may be retried (back to `pending`)
 * or attempted again, and it may still end `undone`.
 */
export const UNDO_TRANSITIONS: Readonly<Record<ReversalUndoStatus, readonly ReversalUndoStatus[]>> =
  Object.freeze({
    pending: ['undone', 'not_needed', 'failed'],
    failed: ['pending', 'undone', 'failed'],
    undone: [],
    not_needed: [],
  });

/** True when an entry in `from` may move to `to`. */
export function canTransitionUndoStatus(from: ReversalUndoStatus, to: ReversalUndoStatus): boolean {
  return UNDO_TRANSITIONS[from].includes(to);
}

/**
 * Asserts an undo move. An illegal move is a `CONFLICT` (409): the entry's current state forbids it. The message is
 * static and names no input value.
 */
export function assertUndoStatusTransition(from: ReversalUndoStatus, to: ReversalUndoStatus): void {
  if (!canTransitionUndoStatus(from, to)) {
    throw new ConflictError('illegal reversal undo status transition', {
      detail: `An undo status of ${from} cannot move to ${to}.`,
    });
  }
}

/** Counts an undo attempt when the entry moves into `undone` or `failed` (each is the outcome of one attempt). */
export function undoAttemptsAfter(attempts: number, to: ReversalUndoStatus): number {
  return to === 'undone' || to === 'failed' ? attempts + 1 : attempts;
}
