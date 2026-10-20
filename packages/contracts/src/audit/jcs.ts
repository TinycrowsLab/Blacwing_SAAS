/**
 * JSON Canonicalization Scheme (JCS, RFC 8785).
 *
 * The audit hash chain hashes the JCS form of an event, so the TypeScript producers and the Go egress
 * gateway must produce byte-identical output for the same value. RFC 8785 defines the output in terms
 * of ECMAScript serialisation, which is why this implementation leans on `JSON.stringify` for
 * primitives:
 *
 * - objects: members sorted by key, comparing UTF-16 code units (§3.2.3), no whitespace;
 * - strings: `JSON.stringify` escaping, which is the RFC's §3.2.2.2 rule set;
 * - numbers: ECMAScript `Number.prototype.toString` (§3.2.2.3), which `JSON.stringify` uses; `-0` is `0`;
 * - literals: `true`, `false`, `null`.
 *
 * Input outside I-JSON (RFC 7493) is rejected rather than coerced: non-finite numbers, lone surrogates,
 * `undefined` array elements, functions, symbols, bigints and non-plain objects. Object members whose
 * value is `undefined` are omitted, matching an optional field that is absent.
 *
 * Strings are NOT Unicode-normalised here (RFC 8785 §3.1 forbids it); the audit schema normalises to
 * NFC before an event is hashed.
 */

/** Thrown for a value JCS cannot represent. */
export class CanonicalJsonError extends Error {
  public constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
  }
}

const HIGH_SURROGATE_MIN = 0xd8_00;
const HIGH_SURROGATE_MAX = 0xdb_ff;
const LOW_SURROGATE_MIN = 0xdc_00;
const LOW_SURROGATE_MAX = 0xdf_ff;

/** True when `value` contains no lone surrogates (I-JSON strings, RFC 7493 §2.1). */
export function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= HIGH_SURROGATE_MIN && unit <= HIGH_SURROGATE_MAX) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= LOW_SURROGATE_MIN && next <= LOW_SURROGATE_MAX)) {
        return false;
      }
      index += 1;
    } else if (unit >= LOW_SURROGATE_MIN && unit <= LOW_SURROGATE_MAX) {
      return false;
    }
  }
  return true;
}

function serialiseString(value: string, path: string): string {
  if (!isWellFormedString(value)) {
    throw new CanonicalJsonError('lone surrogate in string', path);
  }
  return JSON.stringify(value);
}

function compareUtf16(left: string, right: string): number {
  // Default string comparison in ECMAScript is by UTF-16 code unit, which is what §3.2.3 requires.
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function serialise(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean': {
      return value ? 'true' : 'false';
    }
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError('non-finite number', path);
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    case 'string': {
      return serialiseString(value, path);
    }
    case 'object': {
      break;
    }
    default: {
      throw new CanonicalJsonError(`unsupported ${typeof value} value`, path);
    }
  }
  if (seen.has(value)) {
    throw new CanonicalJsonError('circular reference', path);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = (value as readonly unknown[]).map((item, index) => {
        const itemPath = `${path}[${String(index)}]`;
        if (item === undefined) {
          throw new CanonicalJsonError('undefined array element', itemPath);
        }
        return serialise(item, itemPath, seen);
      });
      return `[${items.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError('only plain objects can be canonicalised', path);
    }
    const record = value as Readonly<Record<string, unknown>>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareUtf16)
      .map((key) => {
        const memberPath = `${path}.${key}`;
        return `${serialiseString(key, memberPath)}:${serialise(record[key], memberPath, seen)}`;
      });
    return `{${members.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** The RFC 8785 canonical JSON text of `value`. Throws {@link CanonicalJsonError} for non-I-JSON input. */
export function canonicalJson(value: unknown): string {
  return serialise(value, '$', new Set());
}

/** UTF-8 byte length of a string. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
