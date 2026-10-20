import { DEFAULT_ANTHROPIC_VERSION } from '@blackwing/contracts';

import type { IncomingHttpHeaders } from 'node:http';

/** RFC 9110 §7.6.1 hop-by-hop headers, plus the legacy `proxy-connection` and `keep-alive`. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers never forwarded upstream besides hop-by-hop ones:
 * - `host`/`content-length` are recomputed for the upstream request;
 * - client credentials (`authorization`, `x-api-key`, `cookie`) are the sandbox's per-session key, which
 *   must never leave the gateway; provider credentials are injected by the adapter instead (§4.1, §8.7);
 * - `accept-encoding` is replaced by `identity` so bytes pass through undecoded;
 * - trace headers are re-injected from the gateway's own `gw.messages` span.
 */
const REQUEST_DROP = new Set([
  'host',
  'content-length',
  'authorization',
  'x-api-key',
  'cookie',
  'accept-encoding',
  'traceparent',
  'tracestate',
  'expect',
]);

/** Response headers never returned to the client besides hop-by-hop ones. */
const RESPONSE_DROP = new Set(['content-length', 'content-encoding', 'set-cookie']);

/** Header names listed in a `Connection` header are hop-by-hop for that message (RFC 9110 §7.6.1). */
function connectionTokens(value: string | readonly string[] | null | undefined): Set<string> {
  const joined = typeof value === 'string' ? value : (value ?? []).join(',');
  return new Set(
    joined
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );
}

export interface ForwardedRequestHeaders {
  readonly headers: Readonly<Record<string, string>>;
  /** True when the client sent no `anthropic-version` and the pinned default was used. */
  readonly versionDefaulted: boolean;
}

/** Filters client headers for the upstream request and pins `anthropic-version` when it is missing. */
export function forwardRequestHeaders(incoming: IncomingHttpHeaders): ForwardedRequestHeaders {
  const listed = connectionTokens(incoming.connection);
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(incoming)) {
    const name = rawName.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(name) || REQUEST_DROP.has(name) || listed.has(name)) {
      continue;
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const version = headers['anthropic-version']?.trim() ?? '';
  const versionDefaulted = version.length === 0;
  headers['anthropic-version'] = versionDefaulted ? DEFAULT_ANTHROPIC_VERSION : version;
  headers['content-type'] ??= 'application/json';
  headers['accept-encoding'] = 'identity';
  return { headers, versionDefaulted };
}

/** Filters upstream response headers for the client. */
export function forwardResponseHeaders(upstream: Headers): Record<string, string> {
  const listed = connectionTokens(upstream.get('connection'));
  const headers: Record<string, string> = {};
  upstream.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || RESPONSE_DROP.has(name) || listed.has(name)) {
      return;
    }
    headers[name] = value;
  });
  return headers;
}
