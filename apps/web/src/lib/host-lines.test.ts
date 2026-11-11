import { describe, expect, it } from 'vitest';

import { finishedWhy, finishReason, hostLine } from './host-lines';

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
    expect(line('run.completed', {})).toBe('Finished: Blackwing ended the audit. Your results are ready.');
    expect(
      hostLine({ kind: 'run.paused', data: {}, message: 'Run paused by Jatin Singh.' }, { viewerName: 'Jatin Singh' }),
    ).toBe('Paused by you.');
    expect(line('gate2.decided', { status: 'approved', by: 'u1' })).toBe('You allowed POST /rest/checkout for this run.');
    expect(line('gate2.decided', { status: 'denied', by: 'u1' })).toBe('You denied POST /rest/checkout.');
    expect(line('gate2.decided', { status: 'denied' })).toBe('Denied POST /rest/checkout: the audit was stopping.');
    expect(line('gate2.decided', { status: 'expired' })).toBe('Denied automatically: no answer in 5 min.');
    expect(line('run.paused', {}, 'Run paused by Jatin Singh.')).toBe('Paused by Jatin Singh.');
    expect(line('run.killed', { haltMs: 1840 })).toBe('Stopped. Every agent halted in 1,840 ms.');
    expect(hostLine({ kind: 'run.killed', data: { haltMs: 0 } }, { started: false })).toBe('Stopped before testing began.');
    expect(line('run.completed', { reason: 'duration_budget' })).toBe(
      'Finished: Blackwing stopped at the time limit. Your results are ready.',
    );
    expect(line('run.failed', { reason: 'no_result' })).toBe(
      'The run stopped with an error: no_result. Findings so far are kept.',
    );
    expect(line('agent.message')).toBeNull();
    expect(finishReason(undefined)).toBe('finished its plan');
  });

  it('never calls an unfinished plan finished', () => {
    expect(finishedWhy(undefined, { executed: 6, total: 6 })).toEqual({
      text: 'Blackwing finished its plan: it ran all 6 planned test cases',
      complete: true,
    });
    expect(finishedWhy(undefined, { executed: 0, total: 6 })).toEqual({
      text: 'Blackwing ended the audit early: it ran 0 of 6 planned test cases',
      complete: false,
    });
    expect(finishedWhy('request_budget', { executed: 6, total: 6 }).complete).toBe(false);
    expect(finishedWhy('cost_cap', { executed: 2, total: 5 }).text).toBe(
      'Blackwing reached the spend cap after it ran 2 of 5 planned test cases',
    );
    expect(finishedWhy(undefined, null)).toEqual({ text: 'Blackwing ended the audit', complete: false });
    expect(
      hostLine({ kind: 'run.completed', data: {} }, { cases: { executed: 0, total: 6 } }),
    ).toBe('Finished: Blackwing ended the audit early: it ran 0 of 6 planned test cases. Your results are ready.');
  });

  it('warns when the test accounts are not used', () => {
    expect(hostLine({ kind: 'accounts.unused', data: { roles: ['alice', 'bob'], sentSoFar: 25 } })).toBe(
      'No request has used your test accounts yet (alice, bob). Signed-in testing has not started.',
    );
    expect(hostLine({ kind: 'coverage.summary', data: {} })).toBeNull();
  });
});
