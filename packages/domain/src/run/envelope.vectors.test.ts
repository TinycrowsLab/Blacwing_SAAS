import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { runEnvelopeSchema } from '@blackwing/contracts';
import { canonicaliseValue, envelopeHash } from '@blackwing/crypto';

import { verifyRunEnvelope } from './envelope.js';

/**
 * The shared run-envelope vectors (#399). The same file is consumed by the Go egress gateway, which must reach the
 * same outcome for every case and the same canonical bytes and hash for the signed envelope.
 */
interface Vector {
  readonly description: string;
  readonly typ: string;
  readonly clockSkewSeconds: number;
  readonly publicKeys: readonly {
    readonly kid: string;
    readonly kty: 'OKP';
    readonly crv: 'Ed25519';
    readonly x: string;
  }[];
  readonly signed: {
    readonly envelope: unknown;
    readonly canonical: string;
    readonly envelopeHash: string;
    readonly signingKeyId: string;
    readonly jws: string;
  };
  readonly cases: readonly {
    readonly name: string;
    readonly jws: string;
    readonly now: string;
    readonly expect: { readonly ok: boolean; readonly code?: string };
  }[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../crypto/testvectors/envelope/run-envelope.json', import.meta.url),
    'utf8',
  ),
) as Vector;

const keys = new Map<string, KeyObject>(
  vectors.publicKeys.map((jwk) => [jwk.kid, createPublicKey({ key: jwk, format: 'jwk' })]),
);

describe('shared run-envelope vectors', () => {
  it('declare the run envelope type and the skew the verifier uses', () => {
    expect(vectors.typ).toBe('application/run-envelope+jcs');
    expect(vectors.clockSkewSeconds).toBe(30);
  });

  it('the signed envelope canonicalises to the published bytes and hashes to the published digest', () => {
    const envelope = runEnvelopeSchema.parse(vectors.signed.envelope);
    const bytes = canonicaliseValue(envelope);
    expect(new TextDecoder().decode(bytes)).toBe(vectors.signed.canonical);
    expect(envelopeHash(bytes)).toBe(vectors.signed.envelopeHash);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, vector) => {
    let outcome: { ok: boolean; code?: string | undefined };
    try {
      verifyRunEnvelope(
        vector.jws,
        (kid) => keys.get(kid),
        new Date(vector.now),
        vectors.clockSkewSeconds,
      );
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, code: (error as { code?: string }).code };
    }
    expect(outcome).toEqual(vector.expect);
  });
});
