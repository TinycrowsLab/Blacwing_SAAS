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
const SECRET_EXACT = new Set(['token', 'hash', 'seed', 'pass', 'pwd']);

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
/** A form or query key holding one of these anywhere is a secret (`password_new`, `password_conf`, `user_token`). */
const FORM_PARTS = ['password', 'passwd', 'pwd', 'token', 'apikey', 'secret', 'sessid', 'sessionid'];
/** Names whose prose or config value is a secret: `db_password = x`, `api_key: x`, `` `db_password` `x` ``. Bare `token` is
 *  left out on purpose ("unrecognized token: ..." in an SQL error is evidence, not a secret). */
const PROSE_SECRET = /password|passwd|pwd|passphrase|secret|apikey|accesstoken|authtoken|privatekey/;
const PROSE_EXACT = new Set(['pass']);
/** Unquoted or backticked name, an optional `=`, `:`, `is` or `was`, then a bare or backticked value. */
const PROSE_ASSIGN =
  /(?<![A-Za-z0-9_.-])(`?)([A-Za-z0-9_.-]{0,40}(?:password|passwd|pwd|passphrase|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)[A-Za-z0-9_.-]{0,20}|pass)\1([ \t]{0,8}(?:=|:|\bis\b|\bwas\b)?[ \t]{0,8})(`[^`\r\n]{1,200}`|[^\s`'"<>,;&()[\]{}]{1,200})/gi;
const XML_SECRET = /<([A-Za-z][A-Za-z0-9_:-]{0,63})>([^<\r\n]{1,200})<\/\1>/g;
const CONFIG_ASSIGN =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})(['"]?\s{0,8}\]?\s{0,8}(?:=>?|:|,)\s{0,8})('(?:[^'\\\r\n]|\\.)*'|"(?:[^"\\\r\n]|\\.)*")/g;
const BCRYPT = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g;
const ARGON2 = /\$argon2(?:id|i|d)\$[^\s"']+/g;

function isFormSecret(name: string): boolean {
  const n = norm(name);
  return FORM_EXACT.has(n) || FORM_PARTS.some((part) => n.includes(part));
}

const isProseSecret = (name: string): boolean => PROSE_EXACT.has(norm(name)) || PROSE_SECRET.test(norm(name));

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
    if (!/password|passwd|pwd|secret|apikey|token/.test(n) && !PROSE_EXACT.has(n)) return match;
    // `unrecognized token: "..."` (an SQL error quoting the payload) is evidence; a quoted 'token' key is not prose.
    if (n === 'token' && !/^['"]/.test(sep)) return match;
    const q = quoted[0] ?? "'";
    return `${name}${sep}${q}${scrubbed(n.includes('pass') ? 'password' : 'secret')}${q}`;
  });
  out = out.replace(PROSE_ASSIGN, (match, tick: string, name: string, sep: string, raw: string) => {
    const quoted = raw.startsWith('`');
    const value = quoted ? raw.slice(1, -1) : raw;
    if (!isProseSecret(name) || value.trim() === '' || isPlaceholder(value)) return match;
    const word = sep.trim();
    // A bare value needs `=`, or after `:`/is/was a digit or symbol or an identifier-like name (`db_password`):
    // "the password is wrong" and "Plaintext password: exposed" stay prose.
    const looksSet = /[^A-Za-z]/.test(value) || /[_.-]|[a-z][A-Z]/.test(name) || tick !== '';
    if (!quoted && (word === '' || (word !== '=' && !looksSet))) return match;
    const kind = norm(name).includes('pass') || norm(name) === 'pwd' ? 'password' : 'secret';
    return `${tick}${name}${tick}${sep}${quoted ? `\`${scrubbed(kind)}\`` : scrubbed(kind)}`;
  });
  out = out.replace(XML_SECRET, (match, tag: string, value: string) =>
    isSecretName(tag) && !isPlaceholder(value) ? `<${tag}>${scrubbed(kindFor(tag))}</${tag}>` : match,
  );
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
