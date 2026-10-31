import { describe, expect, it } from 'vitest';

import { createOracleDispatcher, UnknownOracleError } from '../dispatch.js';
import { exchange, header, observation, observationWith } from './fixtures.js';
import { createDeterministicEvaluators, createSignalEvaluators } from './index.js';

describe('createSignalEvaluators', () => {
  it('registers exactly the four declared oracle types', () => {
    const evaluators = createSignalEvaluators(() => undefined);
    expect([...evaluators.keys()].sort()).toEqual([
      'access_matrix',
      'file_read',
      'oob',
      'timing_baseline',
    ]);
  });

  it('routes through the dispatcher and keeps a non-completed observation Suspected', () => {
    const dispatch = createOracleDispatcher(createSignalEvaluators(() => undefined));
    const observation = {
      ...observationWith([exchange({ body: 'x' })]),
      status: 'no_observation' as const,
    };
    expect(dispatch('oob', observation, { channel: 'dns', windowMs: 1000 })).toEqual({
      matched: false,
      suspectedReason: 'no_observation',
    });
  });

  it('reports every evaluation to the metrics port with a bounded label set and leaves the verdict unchanged', () => {
    const seen: { oracleType: string; fired: string }[] = [];
    const metrics = {
      evaluated: (labels: { oracleType: string; fired: string }) => {
        seen.push(labels);
      },
    };
    const evaluators = createSignalEvaluators(
      () => ({ oob: { token: 'tok-abc-123', interactions: [] } }),
      metrics,
    );
    const verdict = evaluators.get('oob')?.(
      observationWith([], '0190a000-0000-7000-8000-000000000001'),
      {
        channel: 'dns',
        windowMs: 1000,
      },
    );
    expect(verdict).toEqual({ matched: false, reason: 'no_correlated_interaction' });
    expect(seen).toEqual([{ oracleType: 'oob', fired: 'false' }]);
  });

  it('fails closed through the dispatcher for an unregistered type', () => {
    const dispatch = createOracleDispatcher(createSignalEvaluators(() => undefined));
    expect(() => dispatch('header_cookie', observationWith([]), {})).toThrow();
  });
});

describe('createDeterministicEvaluators', () => {
  const dispatch = createOracleDispatcher(createDeterministicEvaluators());

  it('reaches each of the four evaluators through the dispatcher by oracle type', () => {
    const baseline = exchange({
      stepIndex: 0,
      evidenceRef: 'evidence/baseline-1',
      status: 200,
      body: '{}',
    });
    const probe = exchange({
      stepIndex: 1,
      status: 500,
      body: 'token-42 SQLSTATE[42000]',
      headers: [header('set-cookie', 'session=abc; HttpOnly')],
    });
    const recorded = observation([baseline, probe]);
    expect(dispatch('marker', recorded, { token: 'token-42' }).matched).toBe(true);
    expect(
      dispatch('status_diff', recorded, { baselineRef: 'evidence/baseline-1', compare: 'status' })
        .matched,
    ).toBe(true);
    expect(
      dispatch('error_signature', recorded, { signatures: ['SQLSTATE[42000]'], scope: 'body' })
        .matched,
    ).toBe(true);
    expect(
      dispatch('header_cookie', recorded, {
        assertions: [
          { target: 'cookie', name: 'session', expectation: 'present', attribute: 'HttpOnly' },
        ],
      }).matched,
    ).toBe(false);
  });

  it('fails closed for an oracle type with no deterministic evaluator', () => {
    expect(() => dispatch('timing_baseline', observation([exchange()]), {})).toThrow(
      UnknownOracleError,
    );
  });

  it('does not resolve a prototype key as an evaluator', () => {
    expect(() => dispatch('constructor', observation([exchange()]), {})).toThrow(
      UnknownOracleError,
    );
  });
});
