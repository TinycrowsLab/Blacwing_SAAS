import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { assertMinimumEvidenceSet, requiredEvidence } from './minimum.js';

const pair = [
  { kind: 'request', role: 'positive' },
  { kind: 'response', role: 'positive' },
  { kind: 'request', role: 'negative_control' },
  { kind: 'response', role: 'negative_control' },
];

describe('requiredEvidence', () => {
  it('requires the replay pair for an error-signature oracle', () => {
    expect(requiredEvidence('error_signature')).toEqual(pair);
  });

  it('adds the interaction record for the OOB oracle', () => {
    expect(requiredEvidence('oob')).toEqual([...pair, { kind: 'oob_interaction', role: 'oracle' }]);
  });
});

describe('assertMinimumEvidenceSet', () => {
  it('passes when the replay pair is present, in any order and with extra items', () => {
    const items = [...pair].reverse().concat({ kind: 'log', role: 'positive' });
    expect(() => {
      assertMinimumEvidenceSet('error_signature', items);
    }).not.toThrow();
  });

  it('refuses a set missing the negative control', () => {
    expect(() => {
      assertMinimumEvidenceSet('error_signature', pair.slice(0, 2));
    }).toThrow(ValidationError);
  });

  it('names the missing kinds and roles, never ids', () => {
    let caught: unknown;
    try {
      assertMinimumEvidenceSet('error_signature', pair.slice(0, 2));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).detail).toBe(
      'Missing evidence: negative_control:request, negative_control:response.',
    );
  });

  it('refuses an OOB finding that has no stored interaction', () => {
    expect(() => {
      assertMinimumEvidenceSet('oob', pair);
    }).toThrow(ValidationError);
  });

  it('accepts an OOB finding once its interaction is stored', () => {
    const items = [...pair, { kind: 'oob_interaction', role: 'oracle' }];
    expect(() => {
      assertMinimumEvidenceSet('oob', items);
    }).not.toThrow();
  });

  it('refuses an empty set', () => {
    expect(() => {
      assertMinimumEvidenceSet('error_signature', []);
    }).toThrow(ValidationError);
  });
});
