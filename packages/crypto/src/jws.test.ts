import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { jcs } from './jcs.js';
import {
  ed25519Jwk,
  envelopeHash,
  type JwsSigner,
  publicKeyOf,
  signEnvelope,
  signJws,
  verifyJws,
} from './jws.js';

const keypair = (kid: string): JwsSigner => ({
  kid,
  privateKey: generateKeyPairSync('ed25519').privateKey,
});
const current = keypair('k1');
const resolver = (signer: JwsSigner) => (kid: string) =>
  kid === signer.kid ? publicKeyOf(signer) : undefined;
const part = (value: string) => Buffer.from(value).toString('base64url');

describe('JWS (EdDSA over JCS)', () => {
  it('round-trips a payload and reports the kid', () => {
    const token = signJws({ b: 2, a: 1 }, current);
    expect(verifyJws(token, resolver(current))).toEqual({ payload: { a: 1, b: 2 }, kid: 'k1' });
  });

  it('is deterministic: key order does not change the token', () => {
    expect(signJws({ a: 1, b: 2 }, current)).toBe(signJws({ b: 2, a: 1 }, current));
  });

  it('rejects a tampered payload', () => {
    const [h, , s] = signJws({ n: 1 }, current).split('.') as [string, string, string];
    expect(verifyJws(`${h}.${part(jcs({ n: 2 }))}.${s}`, resolver(current))).toBeNull();
  });

  it('rejects a token signed by another key', () => {
    const forged = signJws({ n: 1 }, { ...keypair('x'), kid: 'k1' });
    expect(verifyJws(forged, resolver(current))).toBeNull();
  });

  it('rejects an unknown kid', () => {
    expect(verifyJws(signJws({ n: 1 }, keypair('other')), resolver(current))).toBeNull();
  });

  it('rejects alg none and any other algorithm', () => {
    const body = part(jcs({ n: 1 }));
    for (const alg of ['none', 'HS256', 'RS256']) {
      const head = part(jcs({ alg, kid: 'k1' }));
      expect(verifyJws(`${head}.${body}.`, resolver(current))).toBeNull();
      const signature = sign(null, Buffer.from(`${head}.${body}`), current.privateKey);
      expect(
        verifyJws(`${head}.${body}.${signature.toString('base64url')}`, resolver(current)),
      ).toBeNull();
    }
  });

  it('rejects a validly signed but non-canonical payload', () => {
    const head = part(jcs({ alg: 'EdDSA', kid: 'k1', typ: 'JWT' }));
    const body = part('{"b":2, "a":1}');
    const signature = sign(null, Buffer.from(`${head}.${body}`), current.privateKey);
    expect(
      verifyJws(`${head}.${body}.${signature.toString('base64url')}`, resolver(current)),
    ).toBeNull();
  });

  it.each(['', 'a.b', 'a.b.c.d', '..', 'a b.c.d', `${'a'.repeat(5000)}.b.c`, '!!.@@.##'])(
    'rejects malformed input %#',
    (token) => {
      expect(verifyJws(token, resolver(current))).toBeNull();
    },
  );
});

const body = new TextEncoder().encode('{"id":"sa-1","maxIntrusiveness":"safe"}');
const KID = 'bw-sa-signing:v1';

function localKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    privateKey,
    jwk: ed25519Jwk(KID, raw),
    key: {
      kid: KID,
      sign: (input: Uint8Array) => Promise.resolve(new Uint8Array(sign(null, input, privateKey))),
    },
  };
}

describe('signEnvelope', () => {
  it('emits a compact detached JWS with the protected header and no payload segment', async () => {
    const { key } = localKey();
    const jws = await signEnvelope(body, key, 1_700_000_000);
    const [header, payload, sig, ...rest] = jws.compact.split('.');
    expect(rest).toEqual([]);
    expect(payload).toBe('');
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))).toEqual({
      alg: 'EdDSA',
      kid: KID,
      typ: 'application/sa-envelope+jcs',
      iat: 1_700_000_000,
    });
    expect(jws).toMatchObject({ kid: KID, iat: 1_700_000_000 });
  });

  it('records the SHA-256 of the canonical bytes as the envelope hash', async () => {
    const { key } = localKey();
    const jws = await signEnvelope(body, key, 0);
    expect(jws.envelopeHash).toBe(createHash('sha256').update(body).digest('hex'));
    expect(jws.envelopeHash).toBe(envelopeHash(body));
  });

  it('produces a signature that verifies with the exported JWK for its kid', async () => {
    const { key, jwk } = localKey();
    const jws = await signEnvelope(body, key, 1);
    const [header, , sig] = jws.compact.split('.');
    const signingInput = new TextEncoder().encode(
      `${header ?? ''}.${Buffer.from(body).toString('base64url')}`,
    );
    const publicKey = createPublicKey({
      key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      format: 'jwk',
    });
    expect(verify(null, signingInput, publicKey, Buffer.from(sig ?? '', 'base64url'))).toBe(true);
    const protectedHeader = JSON.parse(Buffer.from(header ?? '', 'base64url').toString()) as {
      kid: string;
    };
    expect(jwk.kid).toBe(protectedHeader.kid);
  });

  it('a signature does not verify against a changed body (detached payload binding)', async () => {
    const { key, jwk } = localKey();
    const jws = await signEnvelope(body, key, 1);
    const [header, , sig] = jws.compact.split('.');
    const tampered = Buffer.from('{"id":"sa-1","maxIntrusiveness":"destructive"}').toString(
      'base64url',
    );
    const publicKey = createPublicKey({
      key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      format: 'jwk',
    });
    expect(
      verify(
        null,
        new TextEncoder().encode(`${header ?? ''}.${tampered}`),
        publicKey,
        Buffer.from(sig ?? '', 'base64url'),
      ),
    ).toBe(false);
  });

  it('refuses a signer that returns a signature of the wrong length (fail closed)', async () => {
    const key = { kid: KID, sign: () => Promise.resolve(new Uint8Array(63)) };
    await expect(signEnvelope(body, key, 1)).rejects.toThrow(/64-byte/);
  });

  it('propagates a signer failure instead of emitting an unsigned envelope', async () => {
    const key = { kid: KID, sign: () => Promise.reject(new Error('signer down')) };
    await expect(signEnvelope(body, key, 1)).rejects.toThrow('signer down');
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects iat %s', async (iat) => {
    const { key } = localKey();
    await expect(signEnvelope(body, key, iat)).rejects.toThrow(RangeError);
  });
});

describe('ed25519Jwk', () => {
  it('builds an RFC 8037 OKP key with the base64url public key', () => {
    const raw = new Uint8Array(32).fill(7);
    expect(ed25519Jwk('k', raw)).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(raw).toString('base64url'),
      kid: 'k',
      alg: 'EdDSA',
      use: 'sig',
    });
  });

  it.each([0, 31, 33])('rejects a %i-byte public key', (length) => {
    expect(() => ed25519Jwk('k', new Uint8Array(length))).toThrow(RangeError);
  });
});
