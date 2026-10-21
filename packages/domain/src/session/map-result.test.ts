import { describe, expect, it } from 'vitest';

import { mapResult, SDK_RESULT_SUBTYPES, SUBTASK_STATUSES } from './map-result.js';

describe('mapResult', () => {
  it.each([
    ['success', 'submitted'],
    ['error_max_turns', 'blocked'],
    ['error_max_budget_usd', 'blocked'],
    ['error_during_execution', 'failed'],
    ['error_max_structured_output_retries', 'failed'],
    ['tool_deferred', 'deferred'],
  ] as const)('maps %s to %s', (subtype, status) => {
    const outcome = mapResult({ subtype });
    expect(outcome.status).toBe(status);
    expect(outcome.declined).toBe(false);
  });

  it('gives a clean success no reason and every other subtype one', () => {
    expect(mapResult({ subtype: 'success' }).reason).toBeUndefined();
    for (const subtype of SDK_RESULT_SUBTYPES.filter((s) => s !== 'success')) {
      expect(mapResult({ subtype }).reason).toBe(subtype);
    }
  });

  it('maps a refusal to model_declined for every subtype', () => {
    for (const subtype of SDK_RESULT_SUBTYPES) {
      expect(mapResult({ subtype, stop_reason: 'refusal' })).toEqual({
        status: 'model_declined',
        reason: 'refusal',
        declined: true,
      });
    }
  });

  it('does not treat other stop reasons as a refusal', () => {
    expect(mapResult({ subtype: 'success', stop_reason: 'end_turn' }).status).toBe('submitted');
    expect(mapResult({ subtype: 'success', stop_reason: null }).status).toBe('submitted');
  });

  it('fails closed on an unknown subtype', () => {
    expect(mapResult({ subtype: 'error_new_thing' })).toEqual({
      status: 'failed',
      reason: 'unknown_subtype:error_new_thing',
      declined: false,
    });
  });

  it('fails closed on a success flagged is_error', () => {
    expect(mapResult({ subtype: 'success', is_error: true }).status).toBe('failed');
  });

  it('only ever returns a status of the ORCH-007 enum', () => {
    for (const subtype of [...SDK_RESULT_SUBTYPES, 'bogus']) {
      expect(SUBTASK_STATUSES).toContain(mapResult({ subtype }).status);
    }
  });
});
