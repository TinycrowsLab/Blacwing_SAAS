import { decodeBase32, encodeBase32 } from './base32.js';
import { IdValidationError, type IdValidationReason } from './errors.js';
import {
  NIBBLE_BITS,
  UUID_BYTES,
  UUID_VARIANT_BYTE,
  UUID_VARIANT_MASK,
  UUID_VARIANT_RFC9562,
  UUID_VERSION_7,
  UUID_VERSION_BYTE,
} from './layout.js';
import { type BrandOf, type IdPrefix, isIdPrefix } from './prefixes.js';
import { formatUuidBytes, newId, parseUuid, type Uuid, writeUuidBytes } from './uuid.js';

/**
 * A public id: `<prefix>_<26 lowercase Crockford base32 chars>`, e.g. `run_01jbz3k6w8f5r4t2n9q7x0m1ab`.
 *
 * The body is the 16 bytes of the entity's UUIDv7, so a public id and the `uuid` column are 1:1.
 * Each prefix has its own brand: `PublicId<"run">` is `RunId` and is not assignable to `FindingId`.
 * `PublicId` (no argument) is the union of every entity id type.
 */
export type PublicId<P extends IdPrefix = IdPrefix> = P extends IdPrefix
  ? string & { readonly __brand: BrandOf<P> }
  : never;

/** Result of {@link parsePublicId}. A union over prefixes, so checking `prefix` narrows `id`. */
export type ParsedPublicId<P extends IdPrefix = IdPrefix> = P extends IdPrefix
  ? { readonly prefix: P; readonly uuid: Uuid; readonly id: PublicId<P> }
  : never;

/** Separator between prefix and body. Prefixes never contain it. */
export const PUBLIC_ID_SEPARATOR = '_';

const PREFIX_SHAPE = /^[a-z]+$/;

/** Scratch buffer for encode/decode. Safe to share: every use is synchronous and completes before returning. */
const scratch = new Uint8Array(UUID_BYTES);

const MESSAGES: Readonly<Record<IdValidationReason, string>> = Object.freeze({
  not_a_string: 'public id must be a string',
  malformed: 'public id must look like <prefix>_<body> with a lowercase a-z prefix',
  unknown_prefix: 'public id prefix is not registered',
  prefix_mismatch: 'public id has the wrong prefix',
  invalid_length: 'public id body must be 26 characters',
  invalid_base32: 'public id body must be lowercase Crockford base32 (no i, l, o, u)',
  non_canonical: 'public id body is not a canonical 128-bit encoding',
  invalid_uuid: 'UUID must be a canonical 8-4-4-4-12 hex string',
  not_uuidv7: 'public id does not encode a version-7 UUID',
});

function fail(reason: IdValidationReason, detail?: string): never {
  throw new IdValidationError(
    reason,
    detail === undefined ? MESSAGES[reason] : `${MESSAGES[reason]}: ${detail}`,
  );
}

/**
 * Validates `value` and decodes its body into `scratch`.
 * Returns the prefix on success or the rejection reason; never echoes the input.
 */
function inspect(
  value: unknown,
  expected: IdPrefix | undefined,
): { ok: true; prefix: IdPrefix } | { ok: false; reason: IdValidationReason; detail?: string } {
  if (typeof value !== 'string') return { ok: false, reason: 'not_a_string' };
  const separator = value.indexOf(PUBLIC_ID_SEPARATOR);
  if (separator <= 0 || separator === value.length - 1) return { ok: false, reason: 'malformed' };
  const prefix = value.slice(0, separator);
  if (!PREFIX_SHAPE.test(prefix)) return { ok: false, reason: 'malformed' };
  if (!isIdPrefix(prefix)) return { ok: false, reason: 'unknown_prefix' };
  if (expected !== undefined && prefix !== expected) {
    return {
      ok: false,
      reason: 'prefix_mismatch',
      detail: `expected "${expected}", got "${prefix}"`,
    };
  }
  const decodeError = decodeBase32(value.slice(separator + 1), scratch);
  if (decodeError !== null) return { ok: false, reason: decodeError };
  // Version nibble 0111 in byte 6, RFC 9562 variant 10 in byte 8.
  if (
    (scratch[UUID_VERSION_BYTE] ?? 0) >>> NIBBLE_BITS !== UUID_VERSION_7 ||
    ((scratch[UUID_VARIANT_BYTE] ?? 0) & UUID_VARIANT_MASK) !== UUID_VARIANT_RFC9562
  )
    return { ok: false, reason: 'not_uuidv7' };
  return { ok: true, prefix };
}

function assertKnownPrefix(prefix: unknown): asserts prefix is IdPrefix {
  if (!isIdPrefix(prefix)) fail('unknown_prefix');
}

/**
 * Parses and validates a public id and returns its prefix and canonical UUID.
 * With `expected`, the prefix must also match it. Throws {@link IdValidationError} otherwise.
 */
export function parsePublicId(value: unknown): ParsedPublicId;
export function parsePublicId<P extends IdPrefix>(value: unknown, expected: P): ParsedPublicId<P>;
export function parsePublicId(value: unknown, expected?: IdPrefix): ParsedPublicId {
  if (expected !== undefined) assertKnownPrefix(expected);
  const result = inspect(value, expected);
  if (!result.ok) fail(result.reason, result.detail);
  return {
    prefix: result.prefix,
    uuid: formatUuidBytes(scratch) as Uuid,
    id: value,
  } as ParsedPublicId;
}

/** True when `value` is a valid public id (with prefix `expected`, when given). Never throws for bad input. */
export function isPublicId(value: unknown): value is PublicId;
export function isPublicId<P extends IdPrefix>(value: unknown, expected: P): value is PublicId<P>;
export function isPublicId(value: unknown, expected?: IdPrefix): boolean {
  if (expected !== undefined && !isIdPrefix(expected)) return false;
  return inspect(value, expected).ok;
}

/** The UUIDv7 behind a public id (optionally requiring a prefix). Throws {@link IdValidationError} if invalid. */
export function toUuid(value: unknown, expected?: IdPrefix): Uuid {
  return expected === undefined ? parsePublicId(value).uuid : parsePublicId(value, expected).uuid;
}

/**
 * The public id for a UUIDv7 (either case accepted) and a registered prefix.
 * `toUuid(toPublicId(u, p))` returns `u` in canonical lowercase form.
 */
export function toPublicId<P extends IdPrefix>(uuid: unknown, prefix: P): PublicId<P> {
  assertKnownPrefix(prefix);
  writeUuidBytes(parseUuid(uuid), scratch);
  return `${prefix}${PUBLIC_ID_SEPARATOR}${encodeBase32(scratch)}` as PublicId<P>;
}

/** A new public id backed by a fresh UUIDv7 from {@link newId}. */
export function newPublicId<P extends IdPrefix>(prefix: P): PublicId<P> {
  assertKnownPrefix(prefix);
  writeUuidBytes(newId(), scratch);
  return `${prefix}${PUBLIC_ID_SEPARATOR}${encodeBase32(scratch)}` as PublicId<P>;
}
