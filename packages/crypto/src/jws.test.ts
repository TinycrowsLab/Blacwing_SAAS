import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { jcs } from './jcs.js';
import { type JwsSigner, publicKeyOf, signJws, verifyJws } from './jws.js';

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
