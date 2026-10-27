import { createPublicKey, type KeyObject, sign, verify } from 'node:crypto';

import { jcs } from './jcs.js';

/** The only algorithm: Ed25519 (RFC 8037). `alg: none` and every other value are refused. */
const ALG = 'EdDSA';
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** A compact JWS is `header.payload.signature`; cap the size before any parsing. */
const MAX_JWS_BYTES = 4096;
const JWS_PARTS = 3;

const b64u = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/** A signing key and the id recorded in the token header, so verifiers can pick the right key. */
export interface JwsSigner {
  readonly kid: string;
  readonly privateKey: KeyObject;
}

/** Resolves a `kid` to a public key; `undefined` for an unknown (or retired) key. */
export type JwsKeyResolver = (kid: string) => KeyObject | undefined;

/**
 * Signs `payload` as a compact JWS (RFC 7515) with Ed25519. The payload bytes are the RFC 8785 (JCS)
 * canonical form, so the signed bytes are deterministic (mirrors the SA signatures, §7).
 */
export function signJws(payload: unknown, signer: JwsSigner): string {
  const header = b64u(jcs({ alg: ALG, kid: signer.kid, typ: 'JWT' }));
  const body = b64u(jcs(payload));
  const signature = sign(null, Buffer.from(`${header}.${body}`, 'ascii'), signer.privateKey);
  return `${header}.${body}.${b64u(signature)}`;
}

/**
 * Verifies a compact JWS and returns its payload and `kid`, or `null` for ANY defect (malformed,
 * wrong algorithm, unknown key, bad signature, non-canonical payload). One answer for every failure,
 * so a caller cannot become an oracle. It checks the signature only; claims such as `exp` are the
 * caller's.
 */
export function verifyJws(
  token: string,
  resolveKey: JwsKeyResolver,
): { readonly payload: unknown; readonly kid: string } | null {
  if (token.length > MAX_JWS_BYTES) return null;
  const parts = token.split('.');
  if (parts.length !== JWS_PARTS) return null;
  const [header, body, signature] = parts as [string, string, string];
  if (![header, body, signature].every((part) => BASE64URL.test(part))) return null;
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as unknown;
    if (typeof head !== 'object' || head === null) return null;
    const { alg, kid } = head as { alg?: unknown; kid?: unknown };
    if (alg !== ALG || typeof kid !== 'string') return null;
    const key = resolveKey(kid);
    if (key === undefined) return null;
    const signed = Buffer.from(`${header}.${body}`, 'ascii');
    if (!verify(null, signed, key, Buffer.from(signature, 'base64url'))) return null;
    const text = Buffer.from(body, 'base64url').toString('utf8');
    const payload = JSON.parse(text) as unknown;
    // Only the canonical encoding is accepted, so one payload has exactly one valid token.
    return jcs(payload) === text ? { payload, kid } : null;
  } catch {
    return null;
  }
}

/** The public half of a signer, for registering it with a verifier. */
export function publicKeyOf(signer: JwsSigner): KeyObject {
  return createPublicKey(signer.privateKey);
}
