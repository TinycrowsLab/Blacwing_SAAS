import { idempotencyKeySchema } from '@blackwing/contracts';

/** Per-call options. `headers` cannot override `Authorization` or `Cookie`: the client injects auth last. */
export interface RequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** W3C trace context of the caller, sent as `traceparent`. */
  readonly traceparent?: string;
}

/** RFC 9110 entity-tag: a strong `"tag"` or weak `W/"tag"`. The tag holds visible ASCII without quotes. */
const ETAG_RE = /^(?:W\/)?"[\x21\x23-\x7e]*"$/;
/** W3C trace-context `traceparent` (version 00): `version-traceid-parentid-flags`, lowercase hex. */
const TRACEPARENT_RE = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;

function withHeader(name: string, value: string, base: RequestOptions): RequestOptions {
  return { ...base, headers: { ...base.headers, [name]: value } };
}

/**
 * Sets the `Idempotency-Key` of a POST (§9). The value is checked against the contract (8 to 255 visible
 * ASCII characters), so a bad key fails before any request is sent. A key also makes a POST retryable.
 */
export function withIdempotencyKey(key: string, base: RequestOptions = {}): RequestOptions {
  const parsed = idempotencyKeySchema.safeParse(key);
  if (!parsed.success)
    throw new TypeError('Idempotency-Key must be 8 to 255 visible ASCII characters');
  return withHeader('Idempotency-Key', parsed.data, base);
}

/** Sets `If-Match` to the ETag of the version being changed (optimistic concurrency, §9). */
export function withIfMatch(etag: string, base: RequestOptions = {}): RequestOptions {
  if (!ETAG_RE.test(etag)) throw new TypeError('If-Match must be a quoted entity-tag, e.g. "3"');
  return withHeader('If-Match', etag, base);
}

/** Sets the W3C `traceparent` so the caller's trace continues into the API. */
export function withTraceparent(traceparent: string, base: RequestOptions = {}): RequestOptions {
  if (!TRACEPARENT_RE.test(traceparent))
    throw new TypeError('traceparent is not a W3C trace context');
  return { ...base, traceparent };
}
