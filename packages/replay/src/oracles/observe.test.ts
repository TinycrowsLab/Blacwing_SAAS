import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { observationWith } from './fixtures.js';
import { noopOracleMetrics, observeEvaluator, type OracleMetrics } from './observe.js';

import type { OracleVerdict } from '../oracle.js';

function recorder(): OracleMetrics & { seen: { oracleType: string; fired: string }[] } {
  const seen: { oracleType: string; fired: string }[] = [];
  return {
    seen,
    evaluated: (labels) => {
      seen.push(labels);
    },
  };
}

describe('observeEvaluator', () => {
  it('returns the wrapped verdict unchanged and records one bounded observation', () => {
    const verdict: OracleVerdict = { matched: true, reason: 'sentinel_returned' };
    const metrics = recorder();
    const observed = observeEvaluator('file_read', () => verdict, metrics);
    expect(observed(observationWith([]), {})).toBe(verdict);
    expect(metrics.seen).toEqual([{ oracleType: 'file_read', fired: 'true' }]);
  });

  it('rethrows an evaluator error unchanged and records nothing for it', () => {
    const metrics = recorder();
    const observed = observeEvaluator(
      'oob',
      () => {
        throw new ValidationError('oob params are invalid');
      },
      metrics,
    );
    expect(() => observed(observationWith([]), {})).toThrow(ValidationError);
    expect(metrics.seen).toEqual([]);
  });

  it('defaults to a metrics port that records nothing', () => {
    const observed = observeEvaluator('oob', () => ({ matched: false }));
    expect(observed(observationWith([]), {})).toEqual({ matched: false });
    expect(() => {
      noopOracleMetrics.evaluated({ oracleType: 'oob', fired: 'false' });
    }).not.toThrow();
  });
});
