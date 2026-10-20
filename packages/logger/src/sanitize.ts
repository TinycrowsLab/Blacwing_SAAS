import { serializeErrorForLog } from '@blackwing/errors';

import { isSensitiveKey, longestSecretLength, REDACTED, redactText } from './redaction.js';

/**
 * The safe object walk every logged value passes through before pino serialises it. It turns any
 * value into plain JSON data and:
 *
 * - redacts every string (values and key names) with {@link redactText}, *then* truncates it, so a
 *   secret cut by the truncation can never leave a readable prefix behind;
 * - redacts the whole value under a sensitive key name (`password`, `token`, `authorization`, …) at any
 *   depth;
 * - replaces circular references with `[Circular]`, bounds depth and collection sizes;
 * - serialises errors (with their cause chain), dates, binary data, maps, sets, URLs and Node HTTP
 *   request/response objects without ever throwing (a hostile getter or proxy becomes
 *   `[Unserializable]`).
 */

/** Marker appended to a string cut at {@link SanitizeLimits.maxFieldBytes}. */
export const TRUNCATED = '[truncated]';
/** Marker for a reference back to an ancestor. */
export const CIRCULAR = '[Circular]';
/** Marker for a value that could not be read. */
export const UNSERIALIZABLE = '[Unserializable]';
/** Marker for an object below {@link SanitizeLimits.maxDepth}. */
export const MAX_DEPTH = '[MaxDepth]';

/** Bounds for one logged value. */
export interface SanitizeLimits {
  /** Longest string, in UTF-8 bytes, before it is cut and marked `[truncated]`. */
  readonly maxFieldBytes: number;
  /** Deepest nesting kept; deeper objects become `[MaxDepth]`. */
  readonly maxDepth: number;
  /** Most array items, object keys or map/set entries kept per collection. */
  readonly maxCollectionItems: number;
}

export const DEFAULT_MAX_FIELD_BYTES = 8192;
export const DEFAULT_MAX_DEPTH = 10;
export const DEFAULT_MAX_COLLECTION_ITEMS = 200;

export const DEFAULT_LIMITS: SanitizeLimits = Object.freeze({
  maxFieldBytes: DEFAULT_MAX_FIELD_BYTES,
  maxDepth: DEFAULT_MAX_DEPTH,
  maxCollectionItems: DEFAULT_MAX_COLLECTION_ITEMS,
});

/** Lookahead beyond the cut, so a credential pattern that starts before the cut still matches whole. */
const PATTERN_WINDOW = 1024;

/** First code point that needs 2, 3 and 4 UTF-8 bytes. */
const UTF8_TWO_BYTES = 0x80;
const UTF8_THREE_BYTES = 0x800;
const UTF8_FOUR_BYTES = 0x1_00_00;
/** Most UTF-8 bytes one UTF-16 code unit can encode to (a lone surrogate or a BMP character). */
const MAX_BYTES_PER_CODE_UNIT = 3;
const MAX_BYTES_PER_CODE_POINT = 4;

function utf8Length(codePoint: number): number {
  if (codePoint < UTF8_TWO_BYTES) return 1;
  if (codePoint < UTF8_THREE_BYTES) return 2;
  if (codePoint < UTF8_FOUR_BYTES) return MAX_BYTES_PER_CODE_UNIT;
  return MAX_BYTES_PER_CODE_POINT;
}

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes on a code-point boundary and appends `[truncated]`.
 * Returns `text` unchanged when it fits.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (
    text.length * MAX_BYTES_PER_CODE_UNIT <= maxBytes ||
    Buffer.byteLength(text, 'utf8') <= maxBytes
  )
    return text;
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0;
    const size = utf8Length(codePoint);
    if (bytes + size > maxBytes) break;
    bytes += size;
    // A code point outside the BMP is a surrogate pair: two code units.
    index += codePoint >= UTF8_FOUR_BYTES ? 2 : 1;
  }
  return `${text.slice(0, index)}${TRUNCATED}`;
}

/** Redacts, then truncates. */
export function sanitizeString(text: string, limits: SanitizeLimits): string {
  // Only the head of a huge string can survive truncation, so redact just that head plus enough
  // lookahead for any secret or credential pattern that starts inside it.
  const window = limits.maxFieldBytes + Math.max(longestSecretLength(), PATTERN_WINDOW);
  const head = text.length > window ? text.slice(0, window) : text;
  const redacted = redactText(head);
  const truncated = truncateUtf8(redacted, limits.maxFieldBytes);
  if (head !== text && truncated === redacted) {
    // The head was cut by the window but its redacted form still fits: mark it as truncated anyway.
    return `${redacted}${TRUNCATED}`;
  }
  return truncated;
}

function readProperty(target: object, key: PropertyKey): unknown {
  try {
    return (target as Record<PropertyKey, unknown>)[key];
  } catch {
    return UNSERIALIZABLE;
  }
}

interface HttpRequestLike {
  readonly method: unknown;
  readonly url: unknown;
  readonly headers: unknown;
  readonly socket: unknown;
}

function isHttpRequestLike(value: object): value is HttpRequestLike {
  return 'method' in value && 'headers' in value && 'socket' in value;
}

function isHttpResponseLike(
  value: object,
): value is { statusCode: unknown; getHeaders: () => unknown } {
  return (
    typeof (value as { setHeader?: unknown }).setHeader === 'function' &&
    typeof (value as { getHeaders?: unknown }).getHeaders === 'function'
  );
}

/** The fields of a Node `IncomingMessage` worth logging (pino's `req` shape, minus the body). */
function requestFields(req: HttpRequestLike): Record<string, unknown> {
  const socket = req.socket as { remoteAddress?: unknown; remotePort?: unknown } | null | undefined;
  return {
    method: req.method,
    url: req.url,
    headers: req.headers,
    remoteAddress: socket?.remoteAddress,
    remotePort: socket?.remotePort,
  };
}

function responseFields(res: {
  statusCode: unknown;
  getHeaders: () => unknown;
}): Record<string, unknown> {
  let headers: unknown;
  try {
    headers = res.getHeaders();
  } catch {
    headers = UNSERIALIZABLE;
  }
  return { statusCode: res.statusCode, headers };
}

/** A fresh prototype-less record, so that a logged `__proto__` key stays a plain key. */
function record(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

class Walker {
  private readonly ancestors: object[] = [];

  constructor(private readonly limits: SanitizeLimits) {}

  value(input: unknown, depth: number): unknown {
    switch (typeof input) {
      case 'string':
        return sanitizeString(input, this.limits);
      case 'number':
      case 'boolean':
      case 'undefined':
        return input;
      case 'bigint':
        return input.toString();
      case 'symbol':
        return sanitizeString(input.toString(), this.limits);
      case 'function':
        return undefined;
      case 'object':
        return input === null ? null : this.object(input, depth);
    }
  }

  private object(input: object, depth: number): unknown {
    if (this.ancestors.includes(input)) return CIRCULAR;
    if (depth >= this.limits.maxDepth) return MAX_DEPTH;
    this.ancestors.push(input);
    try {
      return this.objectInner(input, depth);
    } catch {
      return UNSERIALIZABLE;
    } finally {
      this.ancestors.pop();
    }
  }

  private objectInner(input: object, depth: number): unknown {
    if (input instanceof Error) return this.error(input, depth);
    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? 'Invalid Date' : input.toISOString();
    }
    if (
      ArrayBuffer.isView(input) ||
      input instanceof ArrayBuffer ||
      input instanceof SharedArrayBuffer
    ) {
      // Binary data is never dumped: it may hold key material that no text pattern recognises.
      return `[Binary ${String(input.byteLength)} bytes]`;
    }
    if (input instanceof URL) return sanitizeString(input.href, this.limits);
    if (input instanceof RegExp) return sanitizeString(input.toString(), this.limits);
    if (Array.isArray(input)) return this.list(input, depth);
    if (input instanceof Set) return this.list([...input], depth);
    if (input instanceof Map)
      return this.entries(
        [...input].map(([key, value]) => [String(key), value]),
        depth,
      );
    if (isHttpRequestLike(input)) return this.entries(Object.entries(requestFields(input)), depth);
    if (isHttpResponseLike(input))
      return this.entries(Object.entries(responseFields(input)), depth);
    const toJSON = readProperty(input, 'toJSON');
    if (typeof toJSON === 'function') {
      return this.value((toJSON as () => unknown).call(input), depth + 1);
    }
    return this.entries(
      Object.keys(input).map((key) => [key, readProperty(input, key)]),
      depth,
    );
  }

  private list(items: readonly unknown[], depth: number): unknown[] {
    const max = this.limits.maxCollectionItems;
    const out = items.slice(0, max).map((item) => {
      const value = this.value(item, depth + 1);
      // JSON has no `undefined` inside arrays; keep the position.
      return value === undefined ? null : value;
    });
    if (items.length > max) out.push(`${TRUNCATED} ${String(items.length - max)} more items`);
    return out;
  }

  private entries(
    pairs: readonly (readonly [string, unknown])[],
    depth: number,
  ): Record<string, unknown> {
    const out = record();
    const max = this.limits.maxCollectionItems;
    for (const [key, raw] of pairs.slice(0, max)) {
      const safeKey = sanitizeString(key, this.limits);
      if (raw === undefined) continue;
      if (isSensitiveKey(key) && raw !== null && typeof raw !== 'boolean') {
        out[safeKey] = REDACTED;
        continue;
      }
      const value = this.value(raw, depth + 1);
      if (value !== undefined) out[safeKey] = value;
    }
    if (pairs.length > max) out[TRUNCATED] = `${String(pairs.length - max)} more keys`;
    return out;
  }

  private error(err: Error, depth: number): Record<string, unknown> {
    // The cause chain, stacks and AppError code/detail, every string redacted (and depth/cycle bounded)
    // by @blackwing/errors; then the walk truncates those strings and adds the error's own extra
    // fields (`errno`, `syscall`, `statusCode`, ...).
    const serialized = serializeErrorForLog(err, redactText) as unknown as Record<string, unknown>;
    const out = this.entries(Object.entries(serialized), depth);
    const known = new Set(['name', 'message', 'stack', 'cause', 'code', 'detail']);
    const extra = Object.keys(err)
      .filter((key) => !known.has(key))
      .map((key) => [key, readProperty(err, key)] as const);
    if (extra.length > 0) Object.assign(out, this.entries(extra, depth));
    if (!Object.hasOwn(out, 'code')) {
      const code = readProperty(err, 'code');
      if (typeof code === 'string' || typeof code === 'number')
        out.code = this.value(code, depth + 1);
    }
    return out;
  }
}

/** Sanitises one logged value (see the module comment). Never throws. */
export function sanitize(value: unknown, limits: SanitizeLimits = DEFAULT_LIMITS): unknown {
  try {
    return new Walker(limits).value(value, 0);
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * Sanitises a pino merge object or child bindings: always returns a plain record. A Node request or
 * response at the top level is wrapped as `{ req }` / `{ res }`, and an `Error` as `{ err }`, matching
 * pino's own conventions.
 */
export function sanitizeRecord(
  value: object,
  limits: SanitizeLimits = DEFAULT_LIMITS,
): Record<string, unknown> {
  let wrapped: unknown = value;
  try {
    if (value instanceof Error) wrapped = { err: value };
    else if (isHttpRequestLike(value)) wrapped = { req: value };
    else if (isHttpResponseLike(value)) wrapped = { res: value };
  } catch {
    wrapped = UNSERIALIZABLE;
  }
  const result = sanitize(wrapped, limits);
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  const out = record();
  out.value = result;
  return out;
}
