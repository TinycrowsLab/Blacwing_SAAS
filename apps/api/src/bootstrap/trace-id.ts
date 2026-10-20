import { newId } from '@blackwing/ids';

/** Inbound header values as Node delivers them. */
export type HeaderValue = string | readonly string[] | undefined;

/** Request headers by lower-case name (Node's `IncomingHttpHeaders` fits). */
export type TraceHeaders = Readonly<Record<string, HeaderValue>>;

/** W3C trace-context `traceparent`, version 00: `00-<32 hex trace id>-<16 hex parent id>-<2 hex flags>`. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZERO = /^0+$/;

/**
 * Accepted shape of a client-supplied `x-request-id`: short and log-safe, so a header can never inject
 * newlines, control characters or megabytes into log lines.
 */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** First value of a header. A repeated header keeps the first occurrence (the rest are ignored). */
function first(value: HeaderValue): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return value[0];
}

/** Trace id of a valid `traceparent`, or `undefined` (malformed, unknown version, or all-zero ids). */
export function traceIdFromTraceparent(value: HeaderValue): string | undefined {
  const match = TRACEPARENT.exec(first(value)?.trim().toLowerCase() ?? '');
  const traceId = match?.[1];
  const parentId = match?.[2];
  if (traceId === undefined || parentId === undefined) return undefined;
  if (ALL_ZERO.test(traceId) || ALL_ZERO.test(parentId)) return undefined;
  return traceId;
}

/**
 * Correlation id for one request: the trace id of a valid inbound `traceparent`, else a well-formed
 * `x-request-id`, else a fresh UUIDv7. The value only correlates logs and traces; it is client-controlled
 * and must never feed an authorisation or tenancy decision.
 */
export function deriveTraceId(headers: TraceHeaders, generate: () => string = newId): string {
  const fromTraceparent = traceIdFromTraceparent(headers.traceparent);
  if (fromTraceparent !== undefined) return fromTraceparent;
  const requestId = first(headers['x-request-id']);
  if (requestId !== undefined && REQUEST_ID.test(requestId)) return requestId;
  return generate();
}
