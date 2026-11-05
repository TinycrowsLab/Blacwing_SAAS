// Deterministic scope and method rules. Pure functions: no I/O, no model input decides anything here.
export interface Scope {
  readonly allowedOrigins: readonly string[];
  readonly excludedPaths: readonly string[];
}

export type MethodClass = 'active_safe' | 'state_changing' | 'destructive';

export type ScopeVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly rule: string };

/** GET/HEAD/OPTIONS are active_safe, POST/PUT/PATCH need Gate 2, everything else (DELETE, TRACE, CONNECT, unknown) is refused. */
export function classifyMethod(method: string): MethodClass {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
      return 'active_safe';
    case 'POST':
    case 'PUT':
    case 'PATCH':
      return 'state_changing';
    default:
      return 'destructive';
  }
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isUnder(path: string, prefix: string): boolean {
  const base = prefix.toLowerCase().replace(/\/+$/, '');
  const lower = path.toLowerCase();
  return lower === base || lower.startsWith(`${base}/`);
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Scheme+host+port must be an allowed origin and the (dot-segment-normalised) path must not sit under an excluded path. */
export function checkScope(rawUrl: string, scope: Scope): ScopeVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, rule: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, rule: 'scheme_not_allowed' };
  if (url.username !== '' || url.password !== '') return { ok: false, rule: 'credentials_in_url' };
  if (!scope.allowedOrigins.some((o) => originOf(o) === url.origin)) return { ok: false, rule: 'out_of_scope_origin' };
  // Check the decoded path too: many servers decode %2F, so /api%2Fadmin must not slip past an /api/admin exclusion.
  const paths = [url.pathname, safeDecode(url.pathname)];
  if (scope.excludedPaths.some((p) => paths.some((path) => isUnder(path, p)))) return { ok: false, rule: 'excluded_path' };
  return { ok: true, url };
}

/** Gate 2 approval covers this METHOD + path (no query), sent as this test account role (or none), for the rest of the run. */
export function gateKey(method: string, url: URL, role?: string): string {
  return `${method.toUpperCase()} ${url.origin}${url.pathname} as ${role?.toLowerCase() ?? 'no test account'}`;
}
