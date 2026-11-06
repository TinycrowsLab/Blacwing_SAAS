import { describe, expect, it } from 'vitest';

import { finishReason, hostLine } from './host-lines';

describe('host lines', () => {
  const line = (kind: string, data: Record<string, unknown> = {}, message?: string) =>
    hostLine({ kind, data, ...(message === undefined ? {} : { message }) }, {
      request: { method: 'post', url: 'https://s.example.com/rest/checkout?x=1' },
      gate2TimeoutS: 300,
    });

  it('follows the catalogue', () => {
    expect(line('run.queued')).toBe('Audit queued. Scope, limits and authorisation are pinned.');
    expect(line('plan.cases', { cases: [1, 2, 3], total: 9 })).toBe(
      'The planner recorded 3 test cases (9 in the plan).',
    );
    expect(line('plan.cases', { agent: 'authz-specialist', cases: [1], total: 9 })).toBe(
      'The Access control specialist recorded 1 test case (9 in the plan).',
    );
    expect(line('run.completed', {})).toBe('Finished: Claude completed its plan. Your results are ready.');
    expect(
      hostLine({ kind: 'run.paused', data: {}, message: 'Run paused by Jatin Singh.' }, { viewerName: 'Jatin Singh' }),
    ).toBe('Paused by you.');
    expect(line('gate2.decided', { status: 'approved', by: 'u1' })).toBe('You allowed POST /rest/checkout for this run.');
    expect(line('gate2.decided', { status: 'denied', by: 'u1' })).toBe('You denied POST /rest/checkout.');
    expect(line('gate2.decided', { status: 'denied' })).toBe('Denied POST /rest/checkout: the audit was stopping.');
    expect(line('gate2.decided', { status: 'expired' })).toBe('Denied automatically: no answer in 5 min.');
    expect(line('run.paused', {}, 'Run paused by Jatin Singh.')).toBe('Paused by Jatin Singh.');
    expect(line('run.killed', { haltMs: 1840 })).toBe('Stopped. Every agent halted in 1,840 ms.');
    expect(line('run.completed', { reason: 'duration_budget' })).toBe(
      'Finished: stopped at the time limit. Your results are ready.',
    );
    expect(line('run.failed', { reason: 'no_result' })).toBe(
      'The run stopped with an error: no_result. Findings so far are kept.',
    );
    expect(line('agent.message')).toBeNull();
    expect(finishReason(undefined)).toBe('finished its plan');
  });
});
