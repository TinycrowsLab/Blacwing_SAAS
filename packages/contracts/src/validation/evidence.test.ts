import { describe, expect, it } from 'vitest';

import {
  bindEvidenceInputSchema,
  EVIDENCE_KINDS,
  evidenceChainRefSchema,
  evidenceItemSchema,
  MAX_BOUND_EVIDENCE,
  reproArtifactCreateSchema,
  reproArtifactSchema,
} from './evidence.js';

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

const T0 = '2026-01-01T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const ITEM = {
  id: newId(),
  publicId: 'evd_01fwhe4ydgfk1shh6w1g60eecf',
  tenantId: newId(),
  runId: newId(),
  findingId: null,
  occurrenceId: null,
  sequence: 1,
  kind: 'request',
  role: 'positive',
  objectKey: 'tenants/t1/runs/r1/evidence/0001.json',
  sha256: HASH,
  size: 12,
  contentType: 'application/json',
  capturedAt: T0,
  prevChain: null,
  chain: HASH,
  retentionUntil: null,
  legalHold: false,
  createdAt: T0,
  updatedAt: T0,
};
const BUNDLE = {
  id: newId(),
  publicId: 'rpa_01fwhe4ydgfk1shh6w1g60eecf',
  tenantId: ITEM.tenantId,
  findingId: newId(),
  bundleKey: 'tenants/t1/repro/bundle.tar.zst',
  sha256: HASH,
  formatVersion: '1.0',
  size: null,
  createdAt: T0,
  updatedAt: T0,
};

describe('evidenceItemSchema', () => {
  it('accepts a row for every kind', () => {
    for (const kind of EVIDENCE_KINDS) {
      expect(evidenceItemSchema.safeParse({ ...ITEM, kind }).success).toBe(true);
    }
  });

  it.each([
    ['an unknown kind', { kind: 'video' }],
    ['a negative size', { size: -1 }],
    ['a fractional size', { size: 1.5 }],
    ['a size above one object', { size: 5_368_709_121 }],
    ['a sequence of zero', { sequence: 0 }],
    ['an uppercase digest', { sha256: 'A'.repeat(64) }],
    ['a public id with the wrong prefix', { publicId: 'rpa_01fwhe4ydgfk1shh6w1g60eecf' }],
    ['a public id with excluded base32 letters', { publicId: 'evd_01fwhe4ydgfk1shh6w1g60eecl' }],
    ['a content type with parameters', { contentType: 'text/plain; charset=utf-8' }],
    ['an uppercase content type', { contentType: 'Text/Plain' }],
    ['a unicode object key', { objectKey: 'tenants/caf\u00e9/x' }],
    ['a traversal object key', { objectKey: 'tenants/../x' }],
    ['a previous link that is not a digest', { prevChain: 'z' }],
    ['an unknown field', { extra: 1 }],
    ['an inline body field', { body: 'inline' }],
    ['updatedAt before createdAt', { updatedAt: '2025-12-31T00:00:00.000Z' }],
  ])('rejects %s', (_label, patch) => {
    expect(evidenceItemSchema.safeParse({ ...ITEM, ...patch }).success).toBe(false);
  });
});

describe('reproArtifactSchema', () => {
  it('accepts a valid row and rejects a missing finding, a bad version and a negative size', () => {
    expect(reproArtifactSchema.safeParse(BUNDLE).success).toBe(true);
    expect(reproArtifactSchema.safeParse({ ...BUNDLE, findingId: null }).success).toBe(false);
    expect(reproArtifactSchema.safeParse({ ...BUNDLE, formatVersion: '' }).success).toBe(false);
    expect(reproArtifactSchema.safeParse({ ...BUNDLE, size: -5 }).success).toBe(false);
  });
});

describe('reproArtifactCreateSchema', () => {
  const input = {
    findingId: newId(),
    bundleKey: 'tenants/t1/repro/bundle.tar.zst',
    sha256: HASH,
    formatVersion: '1.0',
  };

  it('defaults the size to null and refuses caller-assigned identity fields', () => {
    expect(reproArtifactCreateSchema.parse(input).size).toBeNull();
    expect(reproArtifactCreateSchema.safeParse({ ...input, id: newId() }).success).toBe(false);
    expect(reproArtifactCreateSchema.safeParse({ ...input, publicId: 'rpa_x' }).success).toBe(
      false,
    );
  });
});
