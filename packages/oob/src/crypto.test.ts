import {
  constants as cryptoConstants,
  createCipheriv,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import {
  decodeBase64Strict,
  decryptRecord,
  generateSessionKeys,
  newCorrelationId,
  registrationPublicKey,
  unwrapAesKey,
} from './crypto.js';
import { AES_IV_BYTES, AES_KEY_BYTES, CORRELATION_ID_LENGTH } from './protocol.js';

/** The `AppError` code a synchronous call throws; fails the test if it does not throw an `AppError`. */
function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('expected the call to throw');
}

function sessionPem(): string {
  return generateSessionKeys().publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

function only(records: readonly string[]): string {
  const [record] = records;
  if (record === undefined) throw new Error('expected one sealed record');
  return record;
}

/** What the listener does per poll: wrap a fresh AES-256 key to the session key, then CFB-encrypt each record. */
function sealForSession(publicKeyPem: string, records: readonly string[]) {
  const aesKey = randomBytes(AES_KEY_BYTES);
  const wrapped = publicEncrypt(
    {
      key: createPublicKey(publicKeyPem),
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey,
  );
  const sealed = records.map((plain) => {
    const iv = randomBytes(AES_IV_BYTES);
    const cipher = createCipheriv('aes-256-cfb', aesKey, iv);
    return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
  });
  return { aesKey, wrappedKey: wrapped.toString('base64'), sealed };
}

describe('generateSessionKeys', () => {
  it('produces an RSA-2048 keypair whose public half round-trips through the registration encoding', () => {
    const keys = generateSessionKeys();
    expect(keys.publicKey.asymmetricKeyType).toBe('rsa');
    expect(keys.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    const encoded = registrationPublicKey(keys.publicKey);
    const pem = Buffer.from(encoded, 'base64').toString('utf8');
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(createPublicKey(pem).export({ type: 'spki', format: 'der' })).toEqual(
      keys.publicKey.export({ type: 'spki', format: 'der' }),
    );
  });

  it('gives every session a different keypair', () => {
    const a = registrationPublicKey(generateSessionKeys().publicKey);
    const b = registrationPublicKey(generateSessionKeys().publicKey);
    expect(a).not.toBe(b);
  });
});

describe('newCorrelationId', () => {
  it('returns 20 DNS-safe lowercase characters and does not repeat across draws', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = newCorrelationId();
      expect(id).toMatch(new RegExp(`^[a-z2-7]{${CORRELATION_ID_LENGTH}}$`));
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });
});

describe('decodeBase64Strict', () => {
  it('decodes canonical base64', () => {
    expect(decodeBase64Strict('aGk=', 'field')).toEqual(Buffer.from('hi'));
  });

  it.each([
    ['empty', ''],
    ['bad length', 'aGk'],
    ['junk characters', 'aG!k'],
    ['embedded whitespace', 'aG k='],
    ['padding in the middle', 'a=Gk'],
  ])('refuses %s instead of silently skipping bytes', (_label, value) => {
    expect(() => decodeBase64Strict(value, 'field')).toThrow(AppError);
    expect(thrownCode(() => decodeBase64Strict(value, 'field'))).toBe('OOB_DECRYPT_FAILED');
  });
});

describe('unwrapAesKey', () => {
  it('recovers the AES key the listener wrapped to the session key', () => {
    const keys = generateSessionKeys();
    const sealed = sealForSession(
      keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      [],
    );
    expect(unwrapAesKey(keys.privateKey, sealed.wrappedKey)).toEqual(sealed.aesKey);
  });

  it('fails closed when the key was wrapped to a different session key', () => {
    const mine = generateSessionKeys();
    const theirs = generateSessionKeys();
    const sealed = sealForSession(
      theirs.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      [],
    );
    expect(thrownCode(() => unwrapAesKey(mine.privateKey, sealed.wrappedKey))).toBe(
      'OOB_DECRYPT_FAILED',
    );
  });

  it('refuses a key that unwraps to something other than AES-256', () => {
    const keys = generateSessionKeys();
    const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const wrapped = publicEncrypt(
      {
        key: createPublicKey(pem),
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      randomBytes(16),
    ).toString('base64');
    expect(thrownCode(() => unwrapAesKey(keys.privateKey, wrapped))).toBe('OOB_DECRYPT_FAILED');
  });

  it('refuses a wrapped key that is not canonical base64', () => {
    const keys = generateSessionKeys();
    expect(thrownCode(() => unwrapAesKey(keys.privateKey, 'not base64!'))).toBe(
      'OOB_DECRYPT_FAILED',
    );
  });
});

describe('decryptRecord', () => {
  const aesKey = randomBytes(AES_KEY_BYTES);

  it('round-trips a record sealed with a fresh IV', () => {
    const plain = '{"protocol":"http","full-id":"abc"}';
    const iv = randomBytes(AES_IV_BYTES);
    const cipher = createCipheriv('aes-256-cfb', aesKey, iv);
    const sealed = Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString(
      'base64',
    );
    expect(decryptRecord(aesKey, sealed)).toBe(plain);
  });

  it('round-trips UTF-8 multibyte content byte for byte', () => {
    const plain = 'GET /é?x=☃ HTTP/1.1\r\n\r\n';
    const sealed = sealForSession(sessionPem(), [plain]);
    expect(decryptRecord(sealed.aesKey, only(sealed.sealed))).toBe(plain);
  });

  it('refuses a record shorter than its IV', () => {
    expect(
      thrownCode(() => decryptRecord(aesKey, Buffer.alloc(AES_IV_BYTES).toString('base64'))),
    ).toBe('OOB_DECRYPT_FAILED');
  });

  it('returns garbage, not the plaintext, under the wrong key (the caller rejects it as non-JSON)', () => {
    const other = randomBytes(AES_KEY_BYTES);
    const own = sealForSession(sessionPem(), ['{"a":1}']);
    expect(decryptRecord(other, only(own.sealed))).not.toBe('{"a":1}');
  });
});
