// Deterministic scope and method rules. Pure functions: no I/O, no model input decides anything here.
export interface Scope {
  readonly allowedOrigins: readonly string[];
  readonly excludedPaths: readonly string[];
}

export type MethodClass = 'active_safe' | 'state_changing' | 'destructive';

export type ScopeVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly rule: string };

/** Words in a GET/HEAD path or query that suggest the request changes state (logout links, password resets, ...). */
const STATE_CHANGE_WORDS = /(password|passwd|delete|remove|destroy|logout|signout|sign-out|change|reset|update|transfer|unsubscribe|deactivate)/i;
/** Query keys that usually pick a server-side action. */
const ACTION_KEYS = new Set(['action', 'do', 'cmd', 'op']);

/** The word that makes a GET/HEAD look state-changing, or null. Other methods are classified by method alone. */
export function stateChangeHint(method: string, url: URL): string | null {
  const upper = method.toUpperCase();
  if (upper !== 'GET' && upper !== 'HEAD') return null;
  const word = STATE_CHANGE_WORDS.exec(safeDecode(`${url.pathname}${url.search}`))?.[1];
  if (word !== undefined) return word.toLowerCase();
  for (const key of url.searchParams.keys()) if (ACTION_KEYS.has(key.toLowerCase())) return `${key.toLowerCase()}=`;
  return null;
}

/**
 * GET/HEAD/OPTIONS are active_safe, POST/PUT/PATCH need Gate 2, everything else (DELETE, TRACE, CONNECT, unknown) is
 * refused. With a URL, a GET/HEAD that looks state-changing (see stateChangeHint) also needs Gate 2.
 */
export function classifyMethod(method: string, url?: URL): MethodClass {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return url !== undefined && stateChangeHint(method, url) !== null ? 'state_changing' : 'active_safe';
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

const DECODE_ROUNDS = 3;
const ENCODED_CONTROL = /%(?:[01][0-9a-f]|7f)/i;
const FIRST_PRINTABLE = 0x20;
const DEL = 0x7f;

/** A C0 control byte or DEL, raw or still percent-encoded. */
function hasControlByte(text: string): boolean {
  if (ENCODED_CONTROL.test(text)) return true;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < FIRST_PRINTABLE || code === DEL) return true;
  }
  return false;
}

/** Lower-case, `\` as `/`, `//` collapsed, `;params` stripped per segment, dot segments resolved. */
function canonicalPath(path: string): string {
  const out: string[] = [];
  for (const raw of path.replaceAll('\\', '/').split('/')) {
    const segment = raw.split(';', 1)[0] ?? '';
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return `/${out.join('/')}`.toLowerCase();
}

/**
 * Every form a server might see the path as: raw, each decode round (up to 3, until stable) and the canonical form of
 * each. Null when any form carries a control byte (a NUL or CR/LF can cut a path differently on the server).
 */
function pathForms(pathname: string): string[] | null {
  const decoded = [pathname];
  for (let round = 0; round < DECODE_ROUNDS; round += 1) {
    const next = safeDecode(decoded.at(-1) ?? pathname);
    if (next === decoded.at(-1)) break;
    decoded.push(next);
  }
  if (decoded.some(hasControlByte)) return null;
  return [...decoded, ...decoded.map(canonicalPath)];
}

/** Scheme+host+port must be an allowed origin and no form of the path (see pathForms) may sit under an excluded path. */
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
  const paths = pathForms(url.pathname);
  if (paths === null) return { ok: false, rule: 'invalid_path' };
  // Fail closed: many servers decode %2F, collapse // or drop ;params, so any form under an exclusion is refused.
  if (scope.excludedPaths.some((p) => paths.some((path) => isUnder(path, p)))) return { ok: false, rule: 'excluded_path' };
  return { ok: true, url };
}

/** Gate 2 approval covers this METHOD + path (no query), sent as this test account role (or none), for the rest of the run. */
export function gateKey(method: string, url: URL, role?: string): string {
  return `${method.toUpperCase()} ${url.origin}${url.pathname} as ${role?.toLowerCase() ?? 'no test account'}`;
}
