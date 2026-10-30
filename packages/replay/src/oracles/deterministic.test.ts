import { describe, expect, it } from 'vitest';

import { createOracleDispatcher, UnknownOracleError } from '../dispatch.js';
import { exchange, header, observation } from './fixtures.js';
import { createDeterministicEvaluators } from './index.js';

describe('createDeterministicEvaluators', () => {
  const dispatch = createOracleDispatcher(createDeterministicEvaluators());

  it('reaches each of the four evaluators through the dispatcher by oracle type', () => {
    const probe = exchange({
      status: 500,
      body: 'token-42 SQLSTATE[42000]',
      headers: [header('set-cookie', 'session=abc; HttpOnly')],
    });
    const recorded = observation([probe]);
    expect(dispatch('marker', recorded, { token: 'token-42' }).matched).toBe(true);
    expect(
      dispatch('status_diff', recorded, { expectedStatus: 500, baselineStatus: 200 }).matched,
    ).toBe(true);
    expect(
      dispatch('error_signature', recorded, { signature: 'SQLSTATE[42000]', scope: 'body' })
        .matched,
    ).toBe(true);
    expect(
      dispatch('header_cookie', recorded, {
        target: 'cookie',
        name: 'session',
        expectation: 'present',
        attribute: 'HttpOnly',
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
