import { createHash, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';

import { jcs } from './jcs.js';

/** The only algorithm: Ed25519 (RFC 8037). `alg: none` and every other value are refused. */
const ALG = 'EdDSA';
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** A compact JWS is `header.payload.signature`; cap the size before any parsing. */
const MAX_JWS_BYTES = 4096;
const JWS_PARTS = 3;

const b64u = (data: Uint8Array | string): string => Buffer.from(data).toString('base64url');

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

/**
 * Detached JWS for standing-authorisation envelopes (AUTHZ-004, #376). The payload is the JCS bytes of
 * the envelope, never embedded: the verifier re-derives it from the stored canonical body, so a re-serialised
 * body cannot match the signature. The signer is a callback because the key lives in OpenBao Transit.
 */

export const SA_JWS_ALG = ALG;
export const SA_ENVELOPE_TYP = 'application/sa-envelope+jcs';

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** A signing key: its key id (`kid`) and a signer over the JWS signing input (`header.payload`). */
export interface EnvelopeSigningKey {
  readonly kid: string;
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
}

export interface DetachedJws {
  /** Compact detached serialisation: `BASE64URL(header)..BASE64URL(signature)`. */
  readonly compact: string;
  readonly kid: string;
  /** Issued-at (seconds since epoch) recorded in the protected header. */
  readonly iat: number;
  /** Lowercase hex SHA-256 of the canonical body the signature covers. */
  readonly envelopeHash: string;
}

/** A public Ed25519 key as an RFC 8037 OKP JSON Web Key (RFC 7517 member set). */
export interface Ed25519Jwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
  readonly kid: string;
  readonly alg: typeof SA_JWS_ALG;
  readonly use: 'sig';
}

/** Lowercase hex SHA-256 of the canonical envelope bytes; the audit trail records this digest. */
export function envelopeHash(canonicalBytes: Uint8Array): string {
  return createHash('sha256').update(canonicalBytes).digest('hex');
}

/**
 * Signs the canonical envelope bytes as a detached JWS. Fails closed: a signer that returns anything
 * other than a 64-byte Ed25519 signature is refused rather than emitted.
 */
export async function signEnvelope(
  canonicalBytes: Uint8Array,
  key: EnvelopeSigningKey,
  iat: number,
): Promise<DetachedJws> {
  if (!Number.isSafeInteger(iat) || iat < 0) throw new RangeError('signEnvelope: invalid iat');
  const header = b64u(
    new TextEncoder().encode(
      JSON.stringify({ alg: SA_JWS_ALG, kid: key.kid, typ: SA_ENVELOPE_TYP, iat }),
    ),
  );
  const payload = b64u(canonicalBytes);
  const signature = await key.sign(new TextEncoder().encode(`${header}.${payload}`));
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new RangeError('signEnvelope: signer did not return a 64-byte Ed25519 signature');
  }
  return {
    compact: `${header}..${b64u(signature)}`,
    kid: key.kid,
    iat,
    envelopeHash: envelopeHash(canonicalBytes),
  };
}

/** Builds the JWK for a raw 32-byte Ed25519 public key. */
export function ed25519Jwk(kid: string, rawPublicKey: Uint8Array): Ed25519Jwk {
  if (rawPublicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new RangeError('ed25519Jwk: public key must be 32 bytes');
  }
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: b64u(rawPublicKey),
    kid,
    alg: SA_JWS_ALG,
    use: 'sig',
  };
}
