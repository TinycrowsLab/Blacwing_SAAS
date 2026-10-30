import {
  createDecipheriv,
  constants as cryptoConstants,
  generateKeyPairSync,
  type KeyObject,
  privateDecrypt,
  randomBytes,
} from 'node:crypto';

import { AppError } from '@blackwing/errors';

import {
  AES_IV_BYTES,
  AES_KEY_BYTES,
  CORRELATION_ID_ALPHABET,
  CORRELATION_ID_LENGTH,
  RSA_MODULUS_BITS,
} from './protocol.js';

/** Per-session RSA keypair. Held in memory only: never logged, never written to disk or to the database. */
export interface OobSessionKeys {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

/** Generates the RSA-2048 keypair one client session registers and decrypts with. */
export function generateSessionKeys(): OobSessionKeys {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: RSA_MODULUS_BITS });
  return { publicKey, privateKey };
}

/**
 * The `public-key` field of `/register`: base64 of the SPKI PEM text, as the interactsh client sends it.
 */
export function registrationPublicKey(publicKey: KeyObject): string {
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  return Buffer.from(pem).toString('base64');
}

/** A fresh correlation id: 20 characters from the DNS-safe alphabet, drawn from the CSPRNG without bias. */
export function newCorrelationId(): string {
  const bytes = randomBytes(CORRELATION_ID_LENGTH);
  let id = '';
  for (const byte of bytes)
    id += CORRELATION_ID_ALPHABET.charAt(byte % CORRELATION_ID_ALPHABET.length);
  return id;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Base64 encodes in groups of four characters. */
const BASE64_GROUP_LENGTH = 4;

/**
 * Strict base64 decode. Node's decoder silently skips junk, so a corrupted or truncated field would
 * otherwise decrypt to garbage. Anything that is not canonical base64 is a decrypt failure.
 */
export function decodeBase64Strict(value: string, field: string): Buffer {
  if (value.length === 0 || value.length % BASE64_GROUP_LENGTH !== 0 || !BASE64.test(value)) {
    throw decryptFailed(`${field} is not canonical base64`);
  }
  return Buffer.from(value, 'base64');
}

/**
 * Unwraps the per-batch AES key: RSA-OAEP with SHA-256 under the session's private key. The key must be
 * exactly AES-256; any other length means the server and client disagree, and the batch is refused.
 */
export function unwrapAesKey(privateKey: KeyObject, wrappedKeyBase64: string): Buffer {
  const wrapped = decodeBase64Strict(wrappedKeyBase64, 'aes_key');
  let key: Buffer;
  try {
    key = privateDecrypt(
      { key: privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      wrapped,
    );
  } catch (error) {
    throw decryptFailed('aes_key does not unwrap under the session key', error);
  }
  if (key.length !== AES_KEY_BYTES) {
    throw decryptFailed(`aes_key unwrapped to ${key.length} bytes, expected ${AES_KEY_BYTES}`);
  }
  return key;
}

/**
 * Decrypts one interaction record: base64, then a 16-byte IV followed by AES-256-CFB ciphertext. Returns the
 * record's plaintext JSON text. A wrong key yields garbage that is not JSON, which the caller reports as
 * a decrypt failure too.
 */
export function decryptRecord(aesKey: Buffer, recordBase64: string): string {
  const sealed = decodeBase64Strict(recordBase64, 'data record');
  if (sealed.length <= AES_IV_BYTES) {
    throw decryptFailed('data record is shorter than its IV');
  }
  const iv = sealed.subarray(0, AES_IV_BYTES);
  const ciphertext = sealed.subarray(AES_IV_BYTES);
  const decipher = createDecipheriv('aes-256-cfb', aesKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function decryptFailed(detail: string, cause?: unknown): AppError {
  return new AppError('OOB_DECRYPT_FAILED', 'out-of-band interaction could not be decrypted', {
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}
