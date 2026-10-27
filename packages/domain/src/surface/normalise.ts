import { HTTP_METHODS, type HttpMethod, normaliseHost, normaliseIp } from '@blackwing/contracts';

import { InvalidSurfaceInputError } from './errors.js';

const URL_MAX = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^[0-9]+$/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const HEX_RADIX = 16;
const HTTP_PORT = 80;
const HTTPS_PORT = 443;

/** Canonical `%XX`: unreserved characters decoded, every other escape upper-cased. */
function normalisePercent(segment: string): string {
  return segment.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, HEX_RADIX));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/** Parsed, canonical pieces of an http(s) URL; `host` is punycode, `[v6]` brackets removed. */
export interface SurfaceUrl {
  readonly scheme: 'http' | 'https';
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly template: string;
}

/**
 * Parses an absolute http(s) URL into its canonical, query-value-free template (RECON-002):
 * lowercase scheme and punycode host, default port dropped, userinfo and fragment dropped, dot
 * segments resolved, trailing slash dropped, percent-encoding normalised, numeric and UUID path
 * segments tokenised to `{id}`, query values stripped (names kept, sorted, de-duplicated).
 * @throws {InvalidSurfaceInputError} on anything that is not a well-formed http(s) URL.
 */
export function parseSurfaceUrl(raw: unknown): SurfaceUrl {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > URL_MAX || raw.trim() !== raw) {
    throw new InvalidSurfaceInputError('surface URL is missing or malformed');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidSurfaceInputError('surface URL is missing or malformed');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidSurfaceInputError('surface URL must be http or https');
  }
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  const host = normaliseIp(bare) !== null ? bare : normaliseHost(bare);
  if (host === null || host.length === 0) {
    throw new InvalidSurfaceInputError('surface URL host is invalid');
  }
  const defaultPort = scheme === 'https' ? HTTPS_PORT : HTTP_PORT;
  const port = url.port === '' ? defaultPort : Number(url.port);
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      const seg = normalisePercent(s);
      return NUMERIC.test(seg) || UUID.test(seg) ? '{id}' : seg;
    });
  const path = `/${segments.join('/')}`;
  const names = [...new Set(url.searchParams.keys())].sort();
  const query = names.length === 0 ? '' : `?${names.map((n) => encodeURIComponent(n)).join('&')}`;
  const authority =
    (host.includes(':') ? `[${host}]` : host) + (port === defaultPort ? '' : `:${port}`);
  return { scheme, host, port, path, template: `${scheme}://${authority}${path}${query}` };
}

/** Canonical URL template used in endpoint keys; see {@link parseSurfaceUrl}. */
export function normaliseUrlTemplate(raw: unknown): string {
  return parseSurfaceUrl(raw).template;
}

/** Canonical host: lowercase punycode DNS name or compressed-form IP literal. */
export function canonicalAddress(raw: unknown): string {
  if (typeof raw === 'string') {
    const bare = raw.replace(/^\[|\]$/g, '');
    const ip = normaliseIp(bare);
    if (ip !== null) return ip;
    const host = normaliseHost(raw);
    if (host !== null) return host;
  }
  throw new InvalidSurfaceInputError('surface host or IP is invalid');
}

/** Upper-cased, allow-listed HTTP method. */
export function canonicalMethod(raw: unknown): HttpMethod {
  const method = typeof raw === 'string' ? raw.toUpperCase() : '';
  const found = HTTP_METHODS.find((m) => m === method);
  if (found === undefined) throw new InvalidSurfaceInputError('surface HTTP method is invalid');
  return found;
}
