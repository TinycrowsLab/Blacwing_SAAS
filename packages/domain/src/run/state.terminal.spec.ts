import { describe, expect, it } from 'vitest';

import { approverCtx, eventOf, statusOf } from './state.fixtures.js';
import {
  applyTransition,
  canAcceptTargetTraffic,
  IllegalRunEventError,
  isTerminal,
  RUN_EVENT_TYPES,
  RUN_STATES,
  requiresEnvelope,
  type RunState,
} from './state.js';

const TERMINALS: RunState[] = ['completed', 'cancelled', 'killed', 'failed', 'expired'];
const NON_TERMINALS = RUN_STATES.filter((s) => !TERMINALS.includes(s));

describe('terminal states and universal events', () => {
  it('isTerminal is true exactly for completed, cancelled, killed, failed and expired', () => {
    expect(RUN_STATES.filter(isTerminal)).toEqual(TERMINALS.slice().sort(byGraph));
  });

  it.each([
    ['kill', 'killed'],
    ['sa_expired', 'expired'],
    ['fail', 'failed'],
  ] as const)('%s from every non-terminal state reaches %s', (type, terminal) => {
    for (const from of NON_TERMINALS) {
      const { next, auditIntent } = applyTransition(statusOf(from, 7), eventOf(type), approverCtx);
      expect(next).toEqual({ state: terminal, version: 8 });
      expect(auditIntent).toMatchObject({ from, to: terminal, eventType: type });
    }
  });

  it('terminal states reject every event, except kill on killed which is an idempotent no-op', () => {
    for (const from of TERMINALS) {
      for (const type of RUN_EVENT_TYPES) {
        const status = statusOf(from, 3);
        const run = () => applyTransition(status, eventOf(type), approverCtx);
        const outcome = (() => {
          try {
            return run().next === status ? 'no-op' : 'changed';
          } catch (error) {
            return error instanceof IllegalRunEventError ? 'throws' : 'unexpected error';
          }
        })();
        expect(outcome, `${from} + ${type}`).toBe(
          from === 'killed' && type === 'kill' ? 'no-op' : 'throws',
        );
      }
    }
  });

  it('kill is not idempotent for other terminal states', () => {
    for (const from of TERMINALS.filter((s) => s !== 'killed')) {
      expect(() => applyTransition(statusOf(from), eventOf('kill'), approverCtx)).toThrow(
        IllegalRunEventError,
      );
    }
  });

  it('canAcceptTargetTraffic is true only in recon, executing and validating', () => {
    expect(RUN_STATES.filter(canAcceptTargetTraffic)).toEqual(['recon', 'executing', 'validating']);
  });

  it('requiresEnvelope covers approval through reporting and never a terminal state', () => {
    expect(RUN_STATES.filter(requiresEnvelope)).toEqual([
      'approved',
      'executing',
      'paused',
      'validating',
      'awaiting_gate3',
      'released',
      'reporting',
    ]);
    for (const state of TERMINALS) expect(requiresEnvelope(state)).toBe(false);
  });

  it('traffic states that need no envelope are limited to recon', () => {
    const needing = RUN_STATES.filter(canAcceptTargetTraffic).filter(requiresEnvelope);
    expect(needing).toEqual(['executing', 'validating']);
  });
});

function byGraph(a: RunState, b: RunState): number {
  return RUN_STATES.indexOf(a) - RUN_STATES.indexOf(b);
}
