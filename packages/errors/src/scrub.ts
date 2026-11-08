/**
 * Scrubbing of target data before Blackwing stores, serves or prints it: tokens, cookies, passwords and
 * password hashes that an agent obtained from the site under test. Pure, idempotent, never throws, and
 * every pattern is linear-time (each candidate is anchored and bounded). Configured test-account values
 * are replaced earlier, as `[redacted: role <name>]`; those placeholders pass through unchanged.
 */
import { redactBuiltinSecrets } from './redaction.js';

export type ScrubKind = 'token' | 'credential' | 'secret' | 'password' | 'cookie' | 'hash';

/** What a scrubbed value becomes. */
export const scrubbed = (kind: ScrubKind): string => `[redacted: ${kind}]`;

/** `[redacted: ...]`, or the `<role credential>` placeholder Blackwing prints in a repro curl. */
const isPlaceholder = (value: string): boolean =>
  /^\s*(?:\[redacted(?::[^\]]*)?\]|<[^<>\r\n]{1,80} credential>)/i.test(value);
const norm = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const SECRET_SUFFIXES = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'apikey',
  'privatekey',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'bearertoken',
  'passwordhash',
  'seedphrase',
  'mnemonic',
];
const SECRET_EXACT = new Set(['token', 'hash', 'seed']);

/** Whether an object or JSON key names a secret (the audit ledger's rule plus hashes and seeds). */
function isSecretName(key: string): boolean {
  const n = norm(key);
  return SECRET_EXACT.has(n) || SECRET_SUFFIXES.some((suffix) => n.endsWith(suffix));
}

const kindFor = (key: string): ScrubKind =>
  /pass(word|wd|phrase)$/.test(norm(key)) ? 'password' : 'secret';

const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const HEADER_NAMES =
  'authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token';
/** A header line in raw HTTP or a curl `-H`: the name starts a line, follows a quote or `-H`/`--header`. */
const HEADER_LINE = new RegExp(
  `(^|[\\r\\n'"]|-H\\s{1,8}|--header\\s{1,8})([ \\t]{0,8})(${HEADER_NAMES})(\\s{0,8}:\\s{0,8})([^\\r\\n'"]*)`,
  'gim',
);
const JSON_FIELD = /"([A-Za-z0-9_$.-]{1,64})"(\s{0,8}:\s{0,8})"((?:[^"\\]|\\.)*)"/g;
const ESCAPED_JSON_FIELD = /\\"([A-Za-z0-9_$.-]{1,64})\\"(\s{0,8}:\s{0,8})\\"((?:[^"\\]|\\[^"])*)\\"/g;
const FORM_PAIR = /(?<![A-Za-z0-9_.[\]-])([A-Za-z0-9_.[\]-]{1,64})=(\[redacted[^\]]*\]|[^&\s'"]*)/g;
const FORM_EXACT = new Set(['pwd', 'pass', 'sid', 'session', 'sessionid']);
const FORM_SUFFIXES = ['password', 'passwd', 'token', 'apikey', 'secret', 'sessid', 'sessionid'];
const CONFIG_ASSIGN =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})(['"]?\s{0,8}\]?\s{0,8}(?:=>?|:|,)\s{0,8})('(?:[^'\\\r\n]|\\.)*'|"(?:[^"\\\r\n]|\\.)*")/g;
const BCRYPT = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g;
const ARGON2 = /\$argon2(?:id|i|d)\$[^\s"']+/g;

function isFormSecret(name: string): boolean {
  const n = norm(name);
  return FORM_EXACT.has(n) || FORM_SUFFIXES.some((suffix) => n.endsWith(suffix));
}

function scrubText(text: string): string {
  let out = redactBuiltinSecrets(text);
  out = out.replace(JWT, scrubbed('token'));
  out = out.replace(
    HEADER_LINE,
    (match, lead: string, pad: string, name: string, sep: string, value: string) =>
      value.trim() === '' || isPlaceholder(value)
        ? match
        : `${lead}${pad}${name}${sep}${scrubbed(/cookie/i.test(name) ? 'cookie' : 'credential')}`,
  );
  const jsonField = (match: string, key: string, sep: string, value: string, q: string): string =>
    isSecretName(key) && value !== '' && !isPlaceholder(value)
      ? `${q}"${key}${q}"${sep}${q}"${scrubbed(kindFor(key))}${q}"`
      : match;
  out = out.replace(JSON_FIELD, (m, k: string, s: string, v: string) => jsonField(m, k, s, v, ''));
  out = out.replace(ESCAPED_JSON_FIELD, (m, k: string, s: string, v: string) =>
    jsonField(m, k, s, v, '\\'),
  );
  out = out.replace(FORM_PAIR, (match, name: string, value: string) =>
    value === '' || isPlaceholder(value) || !isFormSecret(name)
      ? match
      : `${name}=${scrubbed('secret')}`,
  );
  out = out.replace(CONFIG_ASSIGN, (match, name: string, sep: string, quoted: string) => {
    const n = norm(name);
    const value = quoted.slice(1, -1);
    if (value === '' || isPlaceholder(value)) return match;
    if (!/password|passwd|secret|apikey|token/.test(n)) return match;
    const q = quoted[0] ?? "'";
    return `${name}${sep}${q}${scrubbed(n.includes('pass') ? 'password' : 'secret')}${q}`;
  });
  out = out.replace(BCRYPT, scrubbed('hash')).replace(ARGON2, scrubbed('hash'));
  return out;
}

/** Scrubs one text. Leaves `[redacted: ...]` placeholders alone; scrub(scrub(x)) === scrub(x). */
export function scrub(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  try {
    return scrubText(text);
  } catch {
    return scrubbed('secret');
  }
}

const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'api-key',
]);

/** Header map: credential headers are replaced whole, every other value goes through scrub(). */
export function scrubHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (typeof value !== 'string') out[name] = value;
    else if (!CREDENTIAL_HEADERS.has(lower)) out[name] = scrub(value);
    else if (isPlaceholder(value)) out[name] = value;
    else out[name] = scrubbed(lower.endsWith('cookie') ? 'cookie' : 'credential');
  }
  return out;
}

const MAX_DEPTH = 32;

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === 'string');

function deep(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrub(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return scrubbed('secret');
  if (Array.isArray(value)) return value.map((item) => deep(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'headers' && isStringMap(v)) out[key] = scrubHeaders(v);
    else if (
      isSecretName(key) &&
      (typeof v === 'number' || (typeof v === 'string' && v !== '' && !isPlaceholder(v)))
    )
      out[key] = scrubbed(kindFor(key));
    else out[key] = deep(v, depth + 1);
  }
  return out;
}

/** JSON-like value: strings scrubbed, secret-named keys replaced, `headers` maps scrubbed. Returns a copy. */
export function scrubDeep<T>(value: T): T {
  try {
    return deep(value, 0) as T;
  } catch {
    return scrubbed('secret') as T;
  }
}
