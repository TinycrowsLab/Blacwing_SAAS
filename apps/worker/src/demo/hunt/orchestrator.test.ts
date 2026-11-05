import { describe, expect, it } from 'vitest';

import { settle } from './orchestrator.js';

describe('settle', () => {
  it('maps how a run ended to its terminal state', () => {
    expect(settle(null, null, { subtype: 'success', summary: 's' })).toEqual({ state: 'completed', reason: null });
    expect(settle(null, null, { subtype: 'error_max_budget_usd', summary: null })).toEqual({ state: 'completed', reason: 'cost_cap' });
    expect(settle(null, null, { subtype: 'error_max_turns', summary: null })).toEqual({ state: 'completed', reason: 'max_turns' });
    expect(settle('duration_budget', 'AbortError', null)).toEqual({ state: 'completed', reason: 'duration_budget' });
    expect(settle(null, 'Error', null)).toEqual({ state: 'failed', reason: 'Error' });
    expect(settle(null, null, null)).toEqual({ state: 'failed', reason: 'no_result' });
    expect(settle(null, null, { subtype: 'error_during_execution', summary: null })).toEqual({ state: 'failed', reason: 'error_during_execution' });
  });
});
