import { describe, expect, it } from 'vitest';

import { createOracleDispatcher } from '../dispatch.js';
import { observationWith, exchange } from './fixtures.js';
import { createSignalEvaluators } from './index.js';

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
