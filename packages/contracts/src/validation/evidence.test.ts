import { describe, expect, it } from 'vitest';

import { bindEvidenceInputSchema, evidenceChainRefSchema, MAX_BOUND_EVIDENCE } from './evidence.js';

const SHA = 'f'.repeat(64);
let seq = 0;
/** A fresh lowercase UUIDv7 per call (the contract checks the shape only). */
function newId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${seq.toString(16).padStart(12, '0')}`;
}
const valid = {
  findingId: newId(),
  occurrenceId: newId(),
  evidenceIds: [newId()],
  oracleType: 'error_signature',
};

describe('bindEvidenceInputSchema', () => {
  it('accepts a well-formed binding', () => {
    expect(bindEvidenceInputSchema.parse(valid)).toEqual(valid);
  });

  it('refuses an empty evidence list and one over the cap', () => {
    expect(bindEvidenceInputSchema.safeParse({ ...valid, evidenceIds: [] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_BOUND_EVIDENCE + 1 }, () => newId());
    expect(bindEvidenceInputSchema.safeParse({ ...valid, evidenceIds: tooMany }).success).toBe(
      false,
    );
  });

  it('refuses an unknown oracle type and unknown fields', () => {
    expect(bindEvidenceInputSchema.safeParse({ ...valid, oracleType: 'vibes' }).success).toBe(
      false,
    );
    expect(bindEvidenceInputSchema.safeParse({ ...valid, body: 'inline' }).success).toBe(false);
  });

  it('refuses ids that are not UUIDv7', () => {
    expect(bindEvidenceInputSchema.safeParse({ ...valid, findingId: 'nope' }).success).toBe(false);
  });
});

describe('evidenceChainRefSchema', () => {
  const ref = { evidenceId: newId(), objectKey: 'tenant/run/000001', sha256: SHA, chain: SHA };

  it('accepts a reference with an object key, a digest and a link', () => {
    expect(evidenceChainRefSchema.parse(ref)).toEqual(ref);
  });

  it('refuses an inline body, a traversal key and a short digest', () => {
    expect(evidenceChainRefSchema.safeParse({ ...ref, body: 'x' }).success).toBe(false);
    expect(evidenceChainRefSchema.safeParse({ ...ref, objectKey: '../secret' }).success).toBe(
      false,
    );
    expect(evidenceChainRefSchema.safeParse({ ...ref, sha256: 'abc' }).success).toBe(false);
  });
});
