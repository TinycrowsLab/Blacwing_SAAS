import { describe, expect, it, vi } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { createOracleDispatcher, type OracleEvaluator, UnknownOracleError } from './dispatch.js';

import type { RawObservation } from './engine.js';

function observation(status: RawObservation['status']): RawObservation {
  return {
    replayId: '0190a000-0000-7000-8000-000000000001',
    candidateId: '0190a000-0000-7000-8000-000000000002',
    testCaseId: 'webapi.injection.sql',
    oracleType: 'error_signature',
    status,
    exchanges: [],
    evidenceRefs: [],
    replayMs: 1,
    attempts: 1,
    pins: {} as RawObservation['pins'],
  };
}

describe('createOracleDispatcher', () => {
  it('routes each oracle type to its own evaluator with the observation and params', () => {
    const marker = vi.fn<OracleEvaluator>(() => ({ matched: true, signature: 'token' }));
    const status = vi.fn<OracleEvaluator>(() => ({ matched: false }));
    const dispatch = createOracleDispatcher(
      new Map([
        ['marker', marker],
        ['status_diff', status],
      ]),
    );
    const params = { token: 'abc' };
    const obs = observation('completed');

    expect(dispatch('marker', obs, params)).toEqual({ matched: true, signature: 'token' });
    expect(marker).toHaveBeenCalledWith(obs, params);
    expect(status).not.toHaveBeenCalled();
    expect(dispatch('status_diff', obs, {})).toEqual({ matched: false });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('fails closed with UnknownOracleError for an unregistered type and calls no evaluator', () => {
    const evaluator = vi.fn<OracleEvaluator>(() => ({ matched: true }));
    const dispatch = createOracleDispatcher(new Map([['marker', evaluator]]));

    expect(() => dispatch('oob', observation('completed'), {})).toThrow(UnknownOracleError);
    expect(evaluator).not.toHaveBeenCalled();
  });

  it('treats the error as a validation failure so callers keep the candidate Suspected', () => {
    const dispatch = createOracleDispatcher(new Map());
    const attempt = (): unknown => dispatch('oob', observation('completed'), {});

    expect(attempt).toThrow(UnknownOracleError);
    expect(attempt).toThrow(ValidationError);
  });

  it('does not resolve prototype keys as evaluators', () => {
    const dispatch = createOracleDispatcher(new Map());
    for (const name of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(() => dispatch(name, observation('completed'), {})).toThrow(UnknownOracleError);
    }
  });

  it('routes a non-completed observation to Suspected without calling the evaluator', () => {
    const evaluator = vi.fn<OracleEvaluator>(() => ({ matched: true }));
    const dispatch = createOracleDispatcher(new Map([['marker', evaluator]]));

    expect(dispatch('marker', observation('no_observation'), {})).toEqual({
      matched: false,
      suspectedReason: 'no_observation',
    });
    expect(dispatch('marker', observation('aborted'), {})).toEqual({
      matched: false,
      suspectedReason: 'aborted',
    });
    expect(evaluator).not.toHaveBeenCalled();
  });
});
