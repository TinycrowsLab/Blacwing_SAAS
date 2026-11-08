// Deterministic scope and method rules. Pure functions: no I/O, no model input decides anything here.
export interface Scope {
  readonly allowedOrigins: readonly string[];
  readonly excludedPaths: readonly string[];
}

export type MethodClass = 'active_safe' | 'state_changing' | 'destructive';

export type ScopeVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly rule: string };

/** Words in a GET/HEAD path segment or query key that suggest the request changes state (logout links, password resets, ...). */
const STATE_CHANGE_WORDS = /(password|passwd|delete|remove|destroy|logout|signout|sign-out|change|reset|update|transfer|unsubscribe|deactivate)/i;
/** Action verbs, matched as whole words in the last path segment (`/basket/1/checkout`, `/feedbacks/1/approve`). */
const PATH_ACTION_WORDS = new Set(['approve', 'promote', 'checkout', 'order', 'erase', 'erasure', 'create', 'add', 'submit']);
/**
 * The same as query keys (`?add=100`, `?create_db=1`), minus words GET forms and lists use for reads: `Submit` is the
 * button of every GET search form, `order` sorts a list.
 */
const KEY_ACTION_WORDS = new Set(['approve', 'promote', 'checkout', 'erase', 'erasure', 'create', 'add']);
/** Query keys that usually pick a server-side action; `_method` overrides the HTTP method on many frameworks. */
const ACTION_KEYS = new Set(['action', 'do', 'cmd', 'op', '_method']);

const words = (text: string): string[] => text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/);

/**
 * The word that makes a GET/HEAD look state-changing, or null. Only path segments and query KEYS are read, never query
 * values, so a read-only probe such as `?page=../../etc/passwd` stays a read. Other methods are classified by method alone.
 */
export function stateChangeHint(method: string, url: URL): string | null {
  const upper = method.toUpperCase();
  if (upper !== 'GET' && upper !== 'HEAD') return null;
  const keys = [...url.searchParams.keys()];
  for (const key of keys) if (ACTION_KEYS.has(key.toLowerCase())) return `${key.toLowerCase()}=`;
  const segments = (decodeForms(url.pathname).at(-1) ?? url.pathname).split('/');
  const word = STATE_CHANGE_WORDS.exec([...segments, ...keys].join('/'))?.[1];
  if (word !== undefined) return word.toLowerCase();
  const action =
    words(segments.findLast((s) => s !== '') ?? '').find((w) => PATH_ACTION_WORDS.has(w)) ??
    keys.flatMap((key) => words(key)).find((w) => KEY_ACTION_WORDS.has(w));
  return action ?? null;
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

const DECODE_ROUNDS = 3;
const ESCAPE = /%([0-9a-f]{2})/gi;
const FIRST_NON_ASCII = 0x80;

/**
 * One decode round. decodeURIComponent throws on a malformed escape (`%ZZ`) or bytes that are not UTF-8 (`%ff`,
 * overlong `%c0%ae`); then each valid escape is decoded on its own, and a non-ASCII byte makes the path invalid (null),
 * because servers differ on how they read it. Never "no decode": that would hide `%61dmin` next to a bad escape.
 */
function decodeOnce(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    const byte = (hex: string): number => Number.parseInt(hex, 16);
    if ([...path.matchAll(ESCAPE)].some((m) => byte(m[1] ?? '') >= FIRST_NON_ASCII)) return null;
    return path.replace(ESCAPE, (_, hex: string) => String.fromCharCode(byte(hex)));
  }
}

/** Raw path plus each decode round (up to 3, until stable); null when a round is invalid (see decodeOnce). */
function decodeForms(pathname: string): string[] {
  const decoded = [pathname];
  for (let round = 0; round < DECODE_ROUNDS; round += 1) {
    const next = decodeOnce(decoded.at(-1) ?? pathname);
    if (next === null) return [];
    if (next === decoded.at(-1)) break;
    decoded.push(next);
  }
  return decoded;
}

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

/** Lower-case, `\` as `/`, `//` collapsed, `;params` and trailing dots/spaces stripped per segment, dot segments resolved. */
function canonicalPath(path: string): string {
  const out: string[] = [];
  for (const raw of path.replaceAll('\\', '/').split('/')) {
    const params = raw.split(';', 1)[0] ?? '';
    const segment = params === '.' || params === '..' ? params : params.replace(/[. ]+$/, '');
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return `/${out.join('/')}`.toLowerCase();
}

/**
 * Every form a server might see the path as: raw, each decode round (up to 3, until stable) and the canonical form of
 * each. Null when a round cannot be decoded safely (see decodeOnce) or any form carries a control byte (a NUL or CR/LF
 * can cut a path differently on the server).
 */
function pathForms(pathname: string): string[] | null {
  const decoded = decodeForms(pathname);
  if (decoded.length === 0 || decoded.some((form) => hasControlByte(form))) return null;
  return [...decoded, ...decoded.map((form) => canonicalPath(form))];
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
