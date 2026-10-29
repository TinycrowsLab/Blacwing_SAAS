// The asset inventory contracts (ASSET-001): the identifier shape, the 64 KiB cap on the jsonb columns and the
// verification rule. The database enforces the same caps (packages/db assets.rls.int.test.ts).

import { describe, expect, it } from 'vitest';

import {
  ASSET_IDENTIFIER_KINDS,
  ASSET_JSON_MAX_BYTES,
  assetAttestationSchema,
  assetIdentifiersSchema,
  assetSchema,
} from '../index.js';

const ID = (n: number): string => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

const url = (value: string) => ({ kind: 'url', value });

const asset = {
  id: ID(3),
  tenantId: ID(1),
  type: 'web_app',
  identifiers: [url('https://app.example.test')],
  environment: 'staging',
  ownerUserId: ID(2),
  verificationStatus: 'unverified',
  verificationMethod: null,
  createdAt: T0,
  updatedAt: T0,
};

describe('asset identifiers', () => {
  it('accepts each identifier kind and nothing else', () => {
    expect(ASSET_IDENTIFIER_KINDS).toEqual(['host', 'url', 'cidr', 'repo']);
    for (const kind of ASSET_IDENTIFIER_KINDS) {
      expect(assetIdentifiersSchema.safeParse([{ kind, value: 'x' }]).success, kind).toBe(true);
    }
    expect(assetIdentifiersSchema.safeParse([{ kind: 'ip', value: '10.0.0.1' }]).success).toBe(
      false,
    );
  });

  it('rejects an identifier with unknown keys or an empty value', () => {
    expect(
      assetIdentifiersSchema.safeParse([{ kind: 'url', value: 'https://a', extra: true }]).success,
    ).toBe(false);
    expect(assetIdentifiersSchema.safeParse([url('')]).success).toBe(false);
  });

  it('needs at least one identifier', () => {
    expect(assetSchema.safeParse({ ...asset, identifiers: [] }).success).toBe(false);
  });

  it('refuses identifiers over the 64 KiB cap the database also enforces', () => {
    // Each value is well under the per-value length limit, so only the total byte cap can refuse this array.
    const many = Array.from({ length: 700 }, (_, i) =>
      url(`https://h${i}.example.test/${'p'.repeat(100)}`),
    );
    expect(assetIdentifiersSchema.safeParse(many).success).toBe(false);
    expect(assetSchema.safeParse({ ...asset, identifiers: many }).success).toBe(false);
  });

  it('accepts identifiers just under the cap', () => {
    const under = Array.from({ length: 300 }, (_, i) =>
      url(`https://h${i}.example.test/${'p'.repeat(100)}`),
    );
    expect(JSON.stringify(under).length).toBeLessThan(ASSET_JSON_MAX_BYTES);
    expect(assetIdentifiersSchema.safeParse(under).success).toBe(true);
  });
});

describe('asset attestation', () => {
  it('is a JSON object, never a bare value', () => {
    expect(assetAttestationSchema.safeParse({ environmentType: 'dev' }).success).toBe(true);
    expect(assetAttestationSchema.safeParse('dev').success).toBe(false);
    expect(assetAttestationSchema.safeParse(['dev']).success).toBe(false);
  });

  it('refuses an attestation over the 64 KiB cap', () => {
    const big = { notes: 'x'.repeat(ASSET_JSON_MAX_BYTES) };
    expect(assetAttestationSchema.safeParse(big).success).toBe(false);
  });
});

describe('asset verification', () => {
  it('a verified asset records how it was verified', () => {
    expect(
      assetSchema.safeParse({ ...asset, verificationStatus: 'verified', verificationMethod: null })
        .success,
    ).toBe(false);
    expect(
      assetSchema.safeParse({
        ...asset,
        verificationStatus: 'verified',
        verificationMethod: 'dns_txt',
      }).success,
    ).toBe(true);
  });

  it('an unverified asset needs no method', () => {
    expect(assetSchema.safeParse(asset).success).toBe(true);
  });

  it('rejects updatedAt before createdAt', () => {
    expect(assetSchema.safeParse({ ...asset, createdAt: T1, updatedAt: T0 }).success).toBe(false);
  });
});
