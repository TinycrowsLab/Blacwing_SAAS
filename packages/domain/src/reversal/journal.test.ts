import { describe, expect, it } from 'vitest';

import { ConflictError } from '@blackwing/errors';

import {
  assertUndoStatusTransition,
  canTransitionUndoStatus,
  UNDO_TRANSITIONS,
  undoAttemptsAfter,
} from './journal.js';

import type { ReversalUndoStatus } from '@blackwing/contracts';

const ALL: readonly ReversalUndoStatus[] = ['pending', 'undone', 'not_needed', 'failed'];

describe('undo status transitions', () => {
  it('lets a pending entry move to undone, not_needed or failed', () => {
    expect(canTransitionUndoStatus('pending', 'undone')).toBe(true);
    expect(canTransitionUndoStatus('pending', 'not_needed')).toBe(true);
    expect(canTransitionUndoStatus('pending', 'failed')).toBe(true);
  });

  it('refuses a pending move to itself', () => {
    expect(canTransitionUndoStatus('pending', 'pending')).toBe(false);
  });

  it('keeps undone and not_needed terminal: nothing reopens them', () => {
    for (const to of ALL) {
      expect(canTransitionUndoStatus('undone', to)).toBe(false);
      expect(canTransitionUndoStatus('not_needed', to)).toBe(false);
    }
  });

  it('lets a failed entry be retried (pending), attempted again (failed) or finished (undone)', () => {
    expect(canTransitionUndoStatus('failed', 'pending')).toBe(true);
    expect(canTransitionUndoStatus('failed', 'failed')).toBe(true);
    expect(canTransitionUndoStatus('failed', 'undone')).toBe(true);
    expect(canTransitionUndoStatus('failed', 'not_needed')).toBe(false);
  });

  it('refuses the late writer that would turn undone back into pending', () => {
    expect(() => {
      assertUndoStatusTransition('undone', 'pending');
    }).toThrow(ConflictError);
  });

  it('has a row for every status', () => {
    expect(Object.keys(UNDO_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('asserts an allowed move without throwing', () => {
    expect(() => {
      assertUndoStatusTransition('pending', 'undone');
    }).not.toThrow();
  });

  it('gives a conflict with a static message that names no input value', () => {
    expect(() => {
      assertUndoStatusTransition('undone', 'pending');
    }).toThrow(ConflictError);
    expect(() => {
      assertUndoStatusTransition('undone', 'pending');
    }).toThrow('illegal reversal undo status transition');
  });
});

describe('undo attempts', () => {
  it('counts an attempt when the entry is undone or fails', () => {
    expect(undoAttemptsAfter(0, 'undone')).toBe(1);
    expect(undoAttemptsAfter(2, 'failed')).toBe(3);
  });

  it('does not count a pending or not_needed move', () => {
    expect(undoAttemptsAfter(2, 'pending')).toBe(2);
    expect(undoAttemptsAfter(2, 'not_needed')).toBe(2);
  });
});
