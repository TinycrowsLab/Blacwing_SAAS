import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_GENESIS_CHAIN,
  evidenceChainLink,
  type EvidenceChainLinkInput,
  sha256Hex,
} from './evidence-chain.js';

const SHA = 'a'.repeat(64);
const BASE: EvidenceChainLinkInput = {
  prevChain: null,
  sha256: SHA,
  kind: 'response',
  role: 'positive',
  size: 42,
  objectKey: 'tenant-1/run-1/000001',
};

describe('sha256Hex', () => {
  it('returns the lowercase hex SHA-256 of the bytes', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });
});

describe('evidenceChainLink', () => {
  it('is deterministic and a 64-character lowercase hex digest', () => {
    const link = evidenceChainLink(BASE);
    expect(link).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceChainLink({ ...BASE })).toBe(link);
  });

  it('treats a null previous link as the genesis value', () => {
    expect(evidenceChainLink(BASE)).toBe(
      evidenceChainLink({ ...BASE, prevChain: EVIDENCE_GENESIS_CHAIN }),
    );
  });

  it.each([
    ['previous link', { prevChain: 'b'.repeat(64) }],
    ['sha256', { sha256: 'c'.repeat(64) }],
    ['kind', { kind: 'request' }],
    ['role', { role: 'negative_control' }],
    ['size', { size: 43 }],
    ['object key', { objectKey: 'tenant-1/run-1/000002' }],
  ])('changes when the %s changes', (_field, change) => {
    expect(evidenceChainLink({ ...BASE, ...change })).not.toBe(evidenceChainLink(BASE));
  });

  it('refuses a field with a newline, so the encoding stays unambiguous', () => {
    expect(() => evidenceChainLink({ ...BASE, objectKey: 'a\nb' })).toThrow(TypeError);
    expect(() => evidenceChainLink({ ...BASE, kind: 'x\n' })).toThrow(TypeError);
  });

  it('keeps fields apart: moving characters between neighbours changes the link', () => {
    const a = evidenceChainLink({ ...BASE, kind: 'ab', role: 'c' });
    const b = evidenceChainLink({ ...BASE, kind: 'a', role: 'bc' });
    expect(a).not.toBe(b);
  });
});
