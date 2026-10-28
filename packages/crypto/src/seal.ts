// Authenticated encryption for everything the BFF hands to the browser or parks in Valkey
// (IAM-002, #334): AES-256-GCM with a random 96-bit nonce, the payload's purpose bound as AAD and an
// embedded expiry. A value sealed for one purpose (the login cookie) therefore never opens as another
// (the session cookie), and any tampering, truncation, wrong key or expiry opens as `null`.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_BYTES = 32;
/** Shortest accepted secret: 32 characters, so a generated hex or base64 value always qualifies. */
export const MIN_SECRET_LENGTH = 32;

/** The AES-256 key for a configured secret (HKDF-SHA-256, so any secret of enough length works). */
export function deriveKey(secret: string): Buffer {
  const key = hkdfSync('sha256', secret, 'blackwing-web-session', 'seal-v1', KEY_BYTES);
  return Buffer.from(key);
}

/** Seals `payload` (JSON-serialisable) for `purpose`; it opens until `now + ttlMs`. */
export function seal(
  key: Buffer,
  purpose: string,
  payload: unknown,
  ttlMs: number,
  now: number,
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify({ exp: now + ttlMs, p: payload }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/**
 * The payload sealed for `purpose`, or `null` when it is forged, corrupt, expired or for another
 * purpose. `keys` is the current key first, then any previous keys still accepted for opening, so a
 * key rotation does not sign anyone out.
 */
export function open(
  keys: readonly Buffer[],
  purpose: string,
  sealed: string,
  now: number,
): unknown {
  for (const key of keys) {
    const payload = openWith(key, purpose, sealed, now);
    if (payload !== null) return payload;
  }
  return null;
}

function openWith(key: Buffer, purpose: string, sealed: string, now: number): unknown {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length <= NONCE_BYTES + TAG_BYTES) return null;
    const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
    const envelope = JSON.parse(plaintext.toString('utf8')) as { exp?: unknown; p?: unknown };
    if (typeof envelope.exp !== 'number' || envelope.exp <= now) return null;
    return envelope.p;
  } catch {
    return null;
  }
}
