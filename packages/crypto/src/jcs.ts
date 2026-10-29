import { createHash } from 'node:crypto';

import { type SaEnvelope, canonicalJson } from '@blackwing/contracts';

/**
 * RFC 8785 JSON Canonicalization Scheme for the JSON subset Blackwing signs and binds as AAD:
 * `null`, booleans, finite numbers, strings, arrays and plain objects. Member names sort by UTF-16
 * code units; strings and numbers serialise the way ECMAScript `JSON.stringify` does, which RFC 8785
 * adopts verbatim. Anything else (undefined members aside) throws rather than canonicalising wrongly.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('jcs: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => jcs(item)).join(',')}]`;
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      throw new TypeError('jcs: not a plain object');
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`jcs: unsupported ${typeof value}`);
}

/** Error code for a non-finite number, which has no JSON representation (#375). */
export const CRYPTO_NONFINITE_NUMBER = 'CRYPTO_NONFINITE_NUMBER';

/** Thrown when a body cannot be canonicalised. `code` is stable for callers and logs. */
export class CanonicalisationError extends Error {
  public constructor(
    public readonly code: typeof CRYPTO_NONFINITE_NUMBER,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalisationError';
  }
}

function assertFiniteNumbers(value: unknown, path: string): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new CanonicalisationError(CRYPTO_NONFINITE_NUMBER, `non-finite number at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      assertFiniteNumbers(item, `${path}[${String(index)}]`);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) assertFiniteNumbers(item, `${path}.${key}`);
  }
}

/**
 * RFC 8785 canonical bytes (UTF-8) of any I-JSON value. Byte-identical to the Go verifier (AUTHZ-006)
 * for the shared vectors in `testdata/jcs-vectors.json`.
 */
export function canonicaliseValue(value: unknown): Uint8Array {
  assertFiniteNumbers(value, '$');
  return new TextEncoder().encode(canonicalJson(value));
}

/** The canonical bytes of an SA envelope: the only byte string that is signed and hashed (§8.1, §8.9). */
export function canonicalise(body: SaEnvelope): Uint8Array {
  return canonicaliseValue(body);
}

/** Lowercase hex SHA-256 of the canonical bytes: the `envelope_hash` pin (§8.9). */
export function canonicalHash(body: SaEnvelope): string {
  return createHash('sha256').update(canonicalise(body)).digest('hex');
}
