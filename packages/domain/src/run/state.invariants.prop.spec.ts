import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { approverCtx, statusOf } from './state.fixtures.js';
import {
  applyTransition,
  canAcceptTargetTraffic,
  IllegalRunEventError,
  type PausedReason,
  isTerminal,
  RUN_EVENT_TYPES,
  type RunEvent,
  type RunStatus,
} from './state.js';

const eventArb: fc.Arbitrary<RunEvent> = fc.oneof(
  fc
    .constantFrom(...RUN_EVENT_TYPES.filter((t) => t !== 'pause'))
    .map((type): RunEvent => ({ type })),
  fc
    .constantFrom<PausedReason[]>('gate2_pending', 'cost_cap', 'operator_pause', 'window_closed')
    .map((reason): RunEvent => ({ type: 'pause', reason })),
);

/** Runs events, skipping illegal ones, and returns every status visited. */
function walk(events: readonly RunEvent[]): RunStatus[] {
  const visited: RunStatus[] = [statusOf('draft')];
  for (const event of events) {
    const last = visited.at(-1) ?? statusOf('draft');
    try {
      const { next } = applyTransition(last, event, approverCtx);
      if (next !== last) visited.push(next);
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalRunEventError);
    }
  }
  return visited;
}

describe('run state invariants (property)', () => {
  it('a terminal state is absorbing: no legal event sequence leaves it', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
        const visited = walk(events);
        const firstTerminal = visited.findIndex((s) => isTerminal(s.state));
        if (firstTerminal === -1) return;
        for (const s of visited.slice(firstTerminal)) {
          expect(s.state).toBe(visited[firstTerminal]?.state);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('kill, sa_expired and fail always terminate any reachable non-terminal run', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { maxLength: 40 }),
        fc.constantFrom('kill', 'sa_expired', 'fail'),
        (events, type) => {
          const end = walk(events).at(-1) ?? statusOf('draft');
          if (isTerminal(end.state)) return;
          expect(isTerminal(applyTransition(end, { type }, approverCtx).next.state)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('target traffic is only ever possible in traffic states, and the version rises by one per change', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
        const visited = walk(events);
        visited.forEach((s, i) => {
          expect(s.version).toBe(i);
          expect(canAcceptTargetTraffic(s.state)).toBe(
            ['recon', 'executing', 'validating'].includes(s.state),
          );
        });
      }),
      { numRuns: 200 },
    );
  });
});
