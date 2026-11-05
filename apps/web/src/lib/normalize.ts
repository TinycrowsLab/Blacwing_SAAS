// Forgiving inputs (experience spec §10): what a person types becomes what the API accepts, and every change we make is
// said out loud as a note. Pure functions, no I/O; the server still validates everything (zod in the API).

/** One change the normaliser made, rendered as "Added `https://`" (text, then `code` in mono, then `after`). */
export interface Note {
  readonly text: string;
  readonly code?: string;
  readonly after?: string;
}

export const noteText = (n: Note): string => `${n.text}${n.code ?? ''}${n.after ?? ''}`;

export type TargetResult =
  | {
      readonly ok: true;
      /** `scheme://host[:port]`, punycoded: what the API stores. */
      readonly origin: string;
      /** `host[:port]`, punycoded. */
      readonly host: string;
      /** The origin as people read it (an IDN host in Unicode). */
      readonly display: string;
      readonly notes: readonly Note[];
      /** The path, query or hash that was typed: context only, the target is the whole origin. */
      readonly pathSetAside?: string;
    }
  | { readonly ok: false; readonly message: string; readonly empty?: true };

const NOT_WEB = "That doesn't look like a web address yet. Try something like app.example.com";
const NOT_HTTP = 'Blackwing audits web apps over http or https.';
const PRIVATE =
  /^(localhost|[^.]+\.local|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|\[::1\])(:\d+)?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/i;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const WRAP_START = /^[<"'`(\[]+/;
const WRAP_END = /[>"'`)\].,;]+$/;
const WRAP_END_IPV6 = /[>"'`).,;]+$/;

/** `host[:port]` as typed, without userinfo, path, query or hash. */
const authorityOf = (rest: string): string => (rest.split(/[/?#]/)[0] ?? '').replace(/^.*@/, '');

function validHost(hostname: string): boolean {
  if (hostname === 'localhost' || IPV4.test(hostname) || IPV6.test(hostname)) return true;
  const labels = hostname.split('.');
  const tld = labels.at(-1) ?? '';
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(tld);
}

/** Turns what someone typed or pasted into the origin we audit (§10.1). Never throws. */
export function normalizeTarget(raw: string): TargetResult {
  let text = raw.trim();
  if (text === '') return { ok: false, message: '', empty: true };
  // IPv6 hosts keep their brackets.
  text = /^\[[0-9a-f:.]+\]/i.test(text)
    ? text.replace(WRAP_END_IPV6, '')
    : text.replace(WRAP_START, '').replace(WRAP_END, '');
  const notes: Note[] = [];
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  let withScheme = text;
  if (scheme !== undefined) {
    if (scheme !== 'http' && scheme !== 'https') return { ok: false, message: NOT_HTTP };
  } else if (PRIVATE.test(authorityOf(text))) {
    withScheme = `http://${text}`;
    notes.push({ text: 'Added ', code: 'http://', after: ' (local address)' });
  } else {
    withScheme = `https://${text}`;
    notes.push({ text: 'Added ', code: 'https://' });
  }
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: NOT_WEB };
  }
  if (!validHost(url.hostname)) return { ok: false, message: NOT_WEB };
  const typedHost = authorityOf(withScheme.replace(SCHEME, ''));
  if (/[A-Z]/.test(typedHost)) notes.push({ text: 'Lower-cased the address' });
  if (url.username !== '' || url.password !== '') {
    notes.push({ text: 'Removed a username and password. Add test accounts on the plan instead.' });
  }
  const rest = `${url.pathname}${url.search}${url.hash}`;
  const pathSetAside = rest === '/' ? undefined : rest;
  if (pathSetAside !== undefined) notes.push({ text: 'Set aside ', code: pathSetAside });
  // URL punycodes an IDN host; people read the Unicode form they typed.
  const displayHost = /[^\x00-\x7F]/.test(typedHost) ? typedHost.toLowerCase().replace(/:(80|443)$/, '') : url.host;
  return {
    ok: true,
    origin: url.origin,
    host: url.host,
    display: `${url.protocol}//${displayHost}`,
    notes,
    ...(pathSetAside === undefined ? {} : { pathSetAside }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Excluded paths (§10.2). The worker matches by prefix, so a chip reads "/admin and everything under it"; no glob is sent.

export const MAX_PATHS = 50;
const PATH_CHARS = /^\/[A-Za-z0-9._~!$&'()+,;=:@%/-]*$/;

export type PathResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string };

/** One token: a path or a same-origin URL becomes a prefix path. */
export function normalizePath(token: string, origin: string | null): PathResult {
  let text = token.trim();
  if (text === '') return { ok: false, message: '' };
  if (/\s/.test(text)) return { ok: false, message: "Paths can't contain spaces" };
  if (SCHEME.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, message: "That doesn't look like a path. Try /admin" };
    }
    if (origin !== null && url.origin !== origin)
      return { ok: false, message: "That's on another site, so it's already out of scope." };
    text = url.pathname;
  }
  if (!text.startsWith('/')) text = `/${text}`;
  text = text.replace(/\/\*\*?$/, '').replace(/\/+$/, '');
  if (text === '') text = '/';
  if (!PATH_CHARS.test(text)) return { ok: false, message: "That doesn't look like a path. Try /admin" };
  return { ok: true, path: text };
}

/** A pasted list (spaces, commas or new lines) added to `existing`: duplicates dropped silently, at most 50. */
export function normalizePaths(
  text: string,
  origin: string | null,
  existing: readonly string[] = [],
): { readonly paths: readonly string[]; readonly error: string | null } {
  const paths = [...existing];
  let error: string | null = null;
  for (const token of text.split(/[\s,]+/)) {
    if (token === '') continue;
    const r = normalizePath(token, origin);
    if (!r.ok) {
      error ??= r.message;
      continue;
    }
    if (paths.includes(r.path)) continue;
    if (paths.length >= MAX_PATHS) {
      error ??= 'Up to 50 paths.';
      continue;
    }
    paths.push(r.path);
  }
  return { paths, error };
}

// ---------------------------------------------------------------------------------------------------------------------
// Limits (§10.3). Out of range is clamped with a note: the person is never blocked.

export interface Range {
  readonly min: number;
  readonly max: number;
}

export type LimitResult =
  | { readonly ok: true; readonly value: number; readonly note: string | null }
  | { readonly ok: false; readonly message: string };

const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const usd = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
  });

function clamp(value: number, range: Range, say: (n: number) => string): LimitResult {
  if (value > range.max)
    return { ok: true, value: range.max, note: `Set to ${say(range.max)}, the most this workspace allows.` };
  if (value < range.min)
    return { ok: true, value: range.min, note: `Set to ${say(range.min)}, the least this workspace allows.` };
  return { ok: true, value, note: null };
}

const MINUTES =
  /^\s*(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?)?)?\s*$/i;
const H_MM = /^\s*(\d+):([0-5]\d)\s*$/;
const MINUTES_PER_HOUR = 60;
const plural = (n: number, one: string, many: string): string => `${fmt(n)} ${n === 1 ? one : many}`;

/** `20`, `20m`, `1h`, `1h30`, `1:30`, `90 minutes`. */
export function parseMinutes(text: string, range: Range): LimitResult {
  const hm = H_MM.exec(text);
  const m = hm === null ? MINUTES.exec(text) : null;
  let minutes: number;
  if (hm !== null) minutes = Number(hm[1]) * MINUTES_PER_HOUR + Number(hm[2]);
  else if (m !== null && (m[1] !== undefined || m[2] !== undefined))
    minutes = Number(m[1] ?? 0) * MINUTES_PER_HOUR + Number(m[2] ?? 0);
  else return { ok: false, message: 'Try something like 30m or 1h30.' };
  return clamp(Math.round(minutes), range, (n) => plural(n, 'minute', 'minutes'));
}

const REQUESTS = /^\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?\s*(k)?\s*$/i;
const THOUSAND = 1000;

/** `1000`, `1,000`, `1k`, `1.5k`. */
export function parseRequests(text: string, range: Range): LimitResult {
  const m = REQUESTS.exec(text);
  if (m === null) return { ok: false, message: 'Try something like 500 or 1k.' };
  const base = Number(`${(m[1] ?? '').replace(/,/g, '')}.${m[2] ?? '0'}`);
  const value = Math.round(m[3] === undefined ? base : base * THOUSAND);
  return clamp(value, range, (n) => plural(n, 'request', 'requests'));
}

const COST = /^\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*(usd)?\s*$/i;

/** `8`, `$8`, `8.50`, `8 usd`. */
export function parseCost(text: string, range: Range): LimitResult {
  const m = COST.exec(text);
  if (m === null) return { ok: false, message: 'Try something like $8 or 12.50.' };
  return clamp(Number(m[1]), range, usd);
}

// ---------------------------------------------------------------------------------------------------------------------
// Test accounts (§10.3).

const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;
const ROLE_MAX = 32;

/** `Customer A` becomes `customer_a`. Null when nothing usable is left. */
export function slugifyRole(text: string): string | null {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, ROLE_MAX);
  return ROLE.test(slug) ? slug : null;
}

const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED_HEADERS = ['host', 'content-length', 'connection', 'transfer-encoding'];

/** Null when the header name is usable; otherwise the message to show. */
export function headerNameError(name: string): string | null {
  if (!HEADER.test(name)) return 'Use a header name like Authorization or Cookie.';
  const lower = name.toLowerCase();
  return RESERVED_HEADERS.includes(lower) ? `Blackwing sets ${lower} itself.` : null;
}

/** Pasting `Authorization: Bearer x` into the value splits on the first colon into header and value. */
export function splitHeaderPaste(value: string): { readonly header: string; readonly value: string } | null {
  const m = /^\s*([A-Za-z0-9-]{1,64})\s*:\s*(\S.*)$/.exec(value);
  return m === null ? null : { header: m[1] ?? '', value: (m[2] ?? '').trim() };
}

const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;

/** A bare JWT under Authorization gets `Bearer ` in front, with a note. */
export function bearerize(header: string, value: string): { readonly value: string; readonly note: string | null } {
  return header.toLowerCase() === 'authorization' && JWT.test(value.trim())
    ? { value: `Bearer ${value.trim()}`, note: 'Added "Bearer " in front of the token.' }
    : { value, note: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reasons (Gate 1, Gate 2 allow, Gate 3): at least 8 non-space characters. Punctuation is never rejected.

export const REASON_MIN = 8;
export const reasonChars = (text: string): number => text.replace(/\s/g, '').length;
export const reasonEnough = (text: string): boolean => reasonChars(text) >= REASON_MIN;
