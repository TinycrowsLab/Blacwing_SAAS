import { describe, expect, it } from 'vitest';

import { exchange, observation } from './fixtures.js';
import { OracleBaselineMissingError } from './shared.js';
import { evaluateStatusDiff } from './status-diff.js';

const BASELINE_REF = 'evidence/baseline-1';
const baseline = (overrides: Parameters<typeof exchange>[0] = {}) =>
  exchange({ stepIndex: 0, evidenceRef: BASELINE_REF, status: 200, body: '{"a":1}', ...overrides });
const probe = (overrides: Parameters<typeof exchange>[0] = {}) =>
  exchange({
    stepIndex: 1,
    evidenceRef: 'evidence/probe-1',
    status: 403,
    body: '{"a":1}',
    ...overrides,
  });
const recorded = (probeOverrides: Parameters<typeof exchange>[0] = {}, base = baseline()) =>
  observation([base, probe(probeOverrides)]);
const status = { baselineRef: BASELINE_REF, compare: 'status' } as const;

describe('evaluateStatusDiff', () => {
  describe('status comparison', () => {
    it('fires when the probe status differs from the recorded baseline', () => {
      expect(evaluateStatusDiff(recorded(), status)).toEqual({
        matched: true,
        reason: 'status_differs',
      });
    });

    it('does not fire when the statuses are equal', () => {
      expect(evaluateStatusDiff(recorded({ status: 200 }), status)).toEqual({
        matched: false,
        reason: 'status_unchanged',
      });
    });
  });

  describe('length comparison', () => {
    const length = { baselineRef: BASELINE_REF, compare: 'length', threshold: 5 } as const;

    it('fires when the body length differs beyond the threshold', () => {
      expect(evaluateStatusDiff(recorded({ body: 'x'.repeat(20), status: 200 }), length)).toEqual({
        matched: true,
        reason: 'length_differs',
      });
    });

    it('does not fire within the threshold', () => {
      expect(evaluateStatusDiff(recorded({ body: '{"a":12}', status: 200 }), length)).toEqual({
        matched: false,
        reason: 'length_within_threshold',
      });
    });

    it('fires on a difference of exactly the threshold plus one', () => {
      // The baseline body '{"a":1}' is 7 characters: 13 gives a difference of 6, one over the threshold.
      expect(
        evaluateStatusDiff(recorded({ body: 'x'.repeat(13), status: 200 }), length).matched,
      ).toBe(true);
    });
  });

  describe('structural comparison', () => {
    const structural = { baselineRef: BASELINE_REF, compare: 'structural', threshold: 0 } as const;

    it('ignores key order and whitespace in JSON bodies', () => {
      const base = baseline({ body: '{"user":"a","roles":["x","y"],"id":1}' });
      const same = probe({
        status: 200,
        body: '{\n  "id": 1,\n  "roles": ["y", "x"],\n  "user": "a"\n}',
      });
      expect(evaluateStatusDiff(observation([base, same]), structural)).toEqual({
        matched: false,
        reason: 'structure_within_threshold',
      });
    });

    it('fires when a JSON value or key differs', () => {
      const base = baseline({ body: '{"user":"a","admin":false}' });
      const changed = probe({ status: 200, body: '{"user":"a","admin":true}' });
      expect(evaluateStatusDiff(observation([base, changed]), structural)).toEqual({
        matched: true,
        reason: 'structure_differs',
      });
    });

    it('ignores whitespace in markup but fires when the tag skeleton changes', () => {
      const base = baseline({ body: '<ul>\n  <li>a</li>\n</ul>', status: 200 });
      expect(
        evaluateStatusDiff(
          observation([base, probe({ status: 200, body: '<ul><li>a</li></ul>' })]),
          structural,
        ).matched,
      ).toBe(false);
      expect(
        evaluateStatusDiff(
          observation([base, probe({ status: 200, body: '<ol><li>a</li></ol>' })]),
          structural,
        ).matched,
      ).toBe(true);
    });

    it('tolerates a threshold of differing tokens', () => {
      const base = baseline({ body: 'one two three', status: 200 });
      const one = probe({ status: 200, body: 'one two four' });
      expect(
        evaluateStatusDiff(observation([base, one]), { ...structural, threshold: 2 }).matched,
      ).toBe(false);
      expect(
        evaluateStatusDiff(observation([base, one]), { ...structural, threshold: 1 }).matched,
      ).toBe(true);
    });

    it('treats a body that only looks like JSON as markup, without throwing', () => {
      const base = baseline({ body: '{not json', status: 200 });
      expect(
        evaluateStatusDiff(
          observation([base, probe({ status: 200, body: '{not json' })]),
          structural,
        ).matched,
      ).toBe(false);
    });

    it('compares NFC-equal Unicode bodies as equal', () => {
      const base = baseline({ body: 'café', status: 200 });
      expect(
        evaluateStatusDiff(observation([base, probe({ status: 200, body: 'café' })]), structural)
          .matched,
      ).toBe(false);
    });
  });

  it('reports no observation when the probe produced no status', () => {
    const noStatus = exchange({ stepIndex: 1, evidenceRef: 'evidence/probe-1', status: null });
    expect(evaluateStatusDiff(observation([baseline(), noStatus]), status)).toEqual({
      matched: false,
      reason: 'no_observation',
    });
  });

  it('reports no observation for an empty observation', () => {
    expect(evaluateStatusDiff(observation([]), status)).toEqual({
      matched: false,
      reason: 'no_observation',
    });
  });

  it('throws when the baseline is not recorded, so the candidate stays Suspected', () => {
    expect(() => evaluateStatusDiff(observation([probe()]), status)).toThrow(
      OracleBaselineMissingError,
    );
    expect(() =>
      evaluateStatusDiff(observation([probe()]), { ...status, baselineRef: 'evidence/other' }),
    ).toThrow(OracleBaselineMissingError);
  });

  it('throws when the baseline reference is absent from the params', () => {
    expect(() => evaluateStatusDiff(recorded(), { compare: 'status' })).toThrow(
      OracleBaselineMissingError,
    );
  });

  it('never uses the probe as its own baseline', () => {
    expect(() =>
      evaluateStatusDiff(observation([probe({ evidenceRef: BASELINE_REF })]), status),
    ).toThrow(OracleBaselineMissingError);
  });

  it('throws when the recorded baseline has no status (a transport failure)', () => {
    const failed = baseline({ status: null });
    expect(() => evaluateStatusDiff(observation([failed, probe()]), status)).toThrow(
      OracleBaselineMissingError,
    );
  });

  it('fails closed without firing for malformed params', () => {
    expect(evaluateStatusDiff(recorded(), { ...status, compare: 'bytes' })).toEqual({
      matched: false,
      reason: 'invalid_params',
    });
    expect(evaluateStatusDiff(recorded(), { ...status, threshold: 3 })).toEqual({
      matched: false,
      reason: 'invalid_params',
    });
    expect(evaluateStatusDiff(recorded(), 'status')).toEqual({
      matched: false,
      reason: 'invalid_params',
    });
  });
});
