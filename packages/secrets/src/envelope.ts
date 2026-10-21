import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { jcs } from '@blackwing/crypto';
import { AppError, type ErrorCode } from '@blackwing/errors';

import type { TransitClient } from './transit.js';

/** Failure of envelope encryption; `code` is one of the registered envelope codes. */
export class EnvelopeError extends AppError {
  constructor(
    code: Extract<
      ErrorCode,
      | 'AAD_MISMATCH'
      | 'SECRET_TOO_LARGE'
      | 'KEK_UNAVAILABLE'
      | 'KEK_DISABLED'
      | 'ENVELOPE_INVALID'
      | 'SECRET_DECRYPT_FAILED'
    >,
    message: string,
    cause?: unknown,
  ) {
    super(code, message, cause === undefined ? {} : { cause });
    this.name = 'EnvelopeError';
  }
}

/** What a ciphertext is bound to besides the tenant (the AAD is `jcs({tenantId, secretId?, purpose})`). */
export interface EnvelopeContext {
  readonly secretId?: string;
  readonly purpose: string;
}

/** Self-describing ciphertext. Safe to persist: no plaintext and no plaintext DEK. */
export interface Envelope {
  readonly v: 1;
  readonly alg: 'AES-256-GCM';
  readonly kekKey: string;
  readonly kekVersion: number;
  /** Vault ciphertext of the DEK (`vault:vN:...`). */
  readonly wrappedDek: string;
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
  /** Hex SHA-256 of the AAD bytes. */
  readonly aadHash: string;
}

export interface EnvelopeMetrics {
  encrypt(): void;
  decrypt(result: 'ok' | 'error'): void;
  rewrap(): void;
}

export interface EnvelopeCryptoOptions {
  readonly transit: TransitClient;
  /** Plaintext cap in bytes. Default 1 MiB. */
  readonly maxPlaintextBytes?: number;
  readonly metrics?: EnvelopeMetrics;
  /** Wraps each operation in a trace span (`secret.crypto`). */
  readonly span?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface EnvelopeCrypto {
  /** The caller owns the returned envelope; plaintext is never retained. */
  encryptSecret(input: {
    tenantId: string;
    plaintext: Uint8Array | string;
    context: EnvelopeContext;
  }): Promise<Envelope>;
  /** Returns plaintext bytes; the caller must never log them and should zero them after use. */
  decryptSecret(
    envelope: Envelope,
    input: { tenantId: string; context: EnvelopeContext },
  ): Promise<Buffer>;
  /** Re-wraps the DEK to the newest KEK version; the data ciphertext is untouched. */
  rewrap(envelope: Envelope, input: { tenantId: string }): Promise<Envelope>;
}

const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRAPPED = /^vault:v(\d+):\S+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function kekKeyFor(tenantId: string): string {
  if (!UUID.test(tenantId)) throw new EnvelopeError('ENVELOPE_INVALID', 'tenantId must be a UUID');
  return `tenant-${tenantId.toLowerCase()}`;
}

/** AAD bytes: JCS of NFC-normalised context, so visually identical text binds identically. */
function aadFor(tenantId: string, context: EnvelopeContext): Buffer {
  if (context.purpose.length === 0)
    throw new EnvelopeError('ENVELOPE_INVALID', 'purpose is required');
  const bound: { tenantId: string; purpose: string; secretId?: string } = {
    tenantId: tenantId.toLowerCase(),
    purpose: context.purpose.normalize('NFC'),
  };
  if (context.secretId !== undefined) bound.secretId = context.secretId.normalize('NFC');
  return Buffer.from(jcs(bound), 'utf8');
}

const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

function versionOf(wrapped: string): number {
  const m = WRAPPED.exec(wrapped);
  if (!m) throw new EnvelopeError('KEK_UNAVAILABLE', 'unexpected wrapped DEK format');
  return Number(m[1]);
}

function b64(value: unknown, bytes?: number): Buffer {
  if (typeof value !== 'string' || !BASE64.test(value)) {
    throw new EnvelopeError('ENVELOPE_INVALID', 'malformed envelope');
  }
  const buf = Buffer.from(value, 'base64');
  if (bytes !== undefined && buf.length !== bytes) {
    throw new EnvelopeError('ENVELOPE_INVALID', 'malformed envelope');
  }
  return buf;
}

/** Validates the untrusted envelope shape (it came from storage). */
function parse(envelope: Envelope): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const e = envelope as unknown as Partial<Record<keyof Envelope, unknown>>;
  if (
    e.v !== 1 ||
    e.alg !== 'AES-256-GCM' ||
    typeof e.kekKey !== 'string' ||
    typeof e.wrappedDek !== 'string' ||
    !WRAPPED.test(e.wrappedDek) ||
    typeof e.aadHash !== 'string'
  ) {
    throw new EnvelopeError('ENVELOPE_INVALID', 'malformed envelope');
  }
  return { iv: b64(e.iv, IV_BYTES), tag: b64(e.tag, TAG_BYTES), ct: b64(e.ct) };
}

export function createEnvelopeCrypto(options: EnvelopeCryptoOptions): EnvelopeCrypto {
  const { transit, metrics } = options;
  const max = options.maxPlaintextBytes ?? DEFAULT_MAX_BYTES;
  const span = options.span ?? (<T>(_name: string, fn: () => Promise<T>) => fn());

  return {
    encryptSecret: ({ tenantId, plaintext, context }) =>
      span('secret.crypto', async () => {
        const kekKey = kekKeyFor(tenantId);
        const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
        if (data.length > max) {
          throw new EnvelopeError('SECRET_TOO_LARGE', `secret exceeds ${String(max)} bytes`);
        }
        const aad = aadFor(tenantId, context);
        const dek = randomBytes(DEK_BYTES);
        try {
          const iv = randomBytes(IV_BYTES);
          const cipher = createCipheriv('aes-256-gcm', dek, iv);
          cipher.setAAD(aad);
          const ct = Buffer.concat([cipher.update(data), cipher.final()]);
          const tag = cipher.getAuthTag();
          const wrappedDek = await transit.encrypt(kekKey, dek.toString('base64'));
          metrics?.encrypt();
          return {
            v: 1,
            alg: 'AES-256-GCM',
            kekKey,
            kekVersion: versionOf(wrappedDek),
            wrappedDek,
            iv: iv.toString('base64'),
            tag: tag.toString('base64'),
            ct: ct.toString('base64'),
            aadHash: sha256Hex(aad),
          } satisfies Envelope;
        } finally {
          dek.fill(0);
        }
      }),

    decryptSecret: (envelope, { tenantId, context }) =>
      span('secret.crypto', async () => {
        try {
          const kekKey = kekKeyFor(tenantId);
          const { iv, tag, ct } = parse(envelope);
          const aad = aadFor(tenantId, context);
          const expected = Buffer.from(sha256Hex(aad));
          const actual = Buffer.from(envelope.aadHash);
          // Checked before any KEK call so a foreign envelope never reaches the KEK of another tenant.
          if (
            envelope.kekKey !== kekKey ||
            actual.length !== expected.length ||
            !timingSafeEqual(actual, expected)
          ) {
            throw new EnvelopeError(
              'AAD_MISMATCH',
              'envelope is not bound to this tenant or purpose',
            );
          }
          const dek = Buffer.from(await transit.decrypt(kekKey, envelope.wrappedDek), 'base64');
          try {
            if (dek.length !== DEK_BYTES)
              throw new EnvelopeError('SECRET_DECRYPT_FAILED', 'bad DEK');
            const decipher = createDecipheriv('aes-256-gcm', dek, iv);
            decipher.setAAD(aad);
            decipher.setAuthTag(tag);
            try {
              const out = Buffer.concat([decipher.update(ct), decipher.final()]);
              metrics?.decrypt('ok');
              return out;
            } catch (cause) {
              throw new EnvelopeError('SECRET_DECRYPT_FAILED', 'authentication failed', cause);
            }
          } finally {
            dek.fill(0);
          }
        } catch (error) {
          metrics?.decrypt('error');
          throw error;
        }
      }),

    rewrap: (envelope, { tenantId }) =>
      span('secret.crypto', async () => {
        const kekKey = kekKeyFor(tenantId);
        parse(envelope);
        if (envelope.kekKey !== kekKey) {
          throw new EnvelopeError('AAD_MISMATCH', 'envelope is not bound to this tenant');
        }
        const wrappedDek = await transit.rewrap(kekKey, envelope.wrappedDek);
        metrics?.rewrap();
        return { ...envelope, wrappedDek, kekVersion: versionOf(wrappedDek) };
      }),
  };
}
