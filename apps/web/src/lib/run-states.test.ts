import { describe, expect, it } from 'vitest';

import { runStateSchema } from '@blackwing/contracts';

import {
  isTerminalState,
  phaseStatus,
  RUN_PHASES,
  RUN_STATE_GROUPS,
  RUN_STATE_LABELS,
  RUN_STATE_TONES,
  RUN_TERMINAL_STATES,
} from './run-states';

describe('run-states', () => {
  it('phases and terminal states cover every contract state exactly once, in §3.3 order', () => {
    const covered = new Set([...RUN_PHASES, ...RUN_TERMINAL_STATES]);
    expect([...covered].sort()).toEqual([...runStateSchema.options].sort());
    expect(RUN_PHASES.indexOf('executing')).toBeLessThan(RUN_PHASES.indexOf('paused'));
    expect(RUN_PHASES.indexOf('paused')).toBeLessThan(RUN_PHASES.indexOf('validating'));
    expect(RUN_PHASES[0]).toBe('draft');
  });

  it('labels, groups and tones are defined for every state', () => {
    for (const state of runStateSchema.options) {
      expect(RUN_STATE_LABELS[state]).toBeTruthy();
      expect(RUN_STATE_GROUPS[state]).toBeTruthy();
      expect(RUN_STATE_TONES[state]).toBeTruthy();
    }
    expect(RUN_STATE_GROUPS.awaiting_gate1).toBe('gate');
    expect(RUN_STATE_GROUPS.executing).toBe('active');
  });

  it('marks earlier phases done, the state current, later upcoming', () => {
    expect(phaseStatus('recon', 'executing')).toBe('done');
    expect(phaseStatus('executing', 'executing')).toBe('current');
    expect(phaseStatus('validating', 'executing')).toBe('upcoming');
    expect(phaseStatus('draft', 'draft')).toBe('current');
  });

  it('completed finishes every phase; an early end checks none', () => {
    expect(RUN_PHASES.filter((p) => phaseStatus(p, 'completed') === 'done')).toHaveLength(
      RUN_PHASES.length - 1,
    );
    for (const phase of RUN_PHASES) expect(phaseStatus(phase, 'killed')).toBe('upcoming');
  });

  it('knows terminal states', () => {
    expect(isTerminalState('killed')).toBe(true);
    expect(isTerminalState('paused')).toBe(false);
  });
});
