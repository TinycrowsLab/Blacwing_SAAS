import { redactionRegistry } from '@blackwing/config';
import { REDACTED, redactBuiltinSecrets, ValidationError } from '@blackwing/errors';

/**
 * Value-based redaction (CONTEXT_PACK §8.7). Path redaction alone misses a secret embedded in a larger
 * string (a proxy URL `http://bwk_…@egress`, a query string, an error message), so every string the
 * logger writes passes through {@link redactText}:
 *
 * 1. every value in the `@blackwing/config` registry (`zSecret()`, `markSecret()`), replaced as an
 *    exact substring, compared by exact UTF-16 code units (no case folding, no Unicode normalisation);
 * 2. every registered secret pattern: Blackwing's own credential formats (`bwk_…` virtual model keys,
 *    `bw_pat_…` personal access tokens, `bw_ci_…` CI tokens) plus any added with
 *    {@link registerSecretPattern};
 * 3. the built-in credential shapes of `@blackwing/errors` (bearer/basic values, URL userinfo, PEM
 *    private keys).
 */

export { REDACTED };

interface PatternEntry {
  readonly name: string;
  readonly pattern: RegExp;
}

const patterns = new Map<string, PatternEntry>();
let patternsVersion = 0;

/** Built-in Blackwing credential formats (§9: `bw_pat_`/`bw_ci_` bearer tokens; virtual model keys `bwk_`; run-scoped `bw_run_` tokens). */
export const BUILTIN_SECRET_PATTERNS: Readonly<Record<string, RegExp>> = Object.freeze({
  'virtual-model-key': /bwk_[A-Za-z0-9_-]+/g,
  'personal-access-token': /bw_pat_[A-Za-z0-9_-]+/g,
  'ci-token': /bw_ci_[A-Za-z0-9_-]+/g,
  // Run-scoped service tokens (sandbox controller, Run Broker): `bw_run_<payload>.<signature>`.
  'run-token': /bw_run_[A-Za-z0-9_.-]+/g,
});

/**
 * Registers a pattern whose every match is replaced with `[REDACTED]` in all log output. Use it for
 * credential *formats* (a prefix and an alphabet); use `markSecret` from `@blackwing/config` for known
 * *values*. Re-registering a name replaces the previous pattern.
 *
 * The pattern is copied with the `g` flag added and the `y` flag removed. It must not match the empty
 * string (that would match at every position). Patterns are code, never user input: keep them linear
 * (no nested quantifiers) because they run on every log line.
 *
 * Returns a function that removes the pattern again.
 */
export function registerSecretPattern(name: string, pattern: RegExp): () => boolean {
  if (name.length === 0) {
    throw new ValidationError('secret pattern name must not be empty');
  }
  const flags = `${pattern.flags.replace(/[gy]/g, '')}g`;
  const compiled = new RegExp(pattern.source, flags);
  if (new RegExp(pattern.source, flags.replace('g', '')).test('')) {
    throw new ValidationError(`secret pattern "${name}" matches the empty string`);
  }
  const entry: PatternEntry = { name, pattern: compiled };
  patterns.set(name, entry);
  patternsVersion += 1;
  return () => {
    if (patterns.get(name) !== entry) return false;
    patterns.delete(name);
    patternsVersion += 1;
    return true;
  };
}

/** Names of the registered secret patterns, in registration order. */
export function secretPatternNames(): readonly string[] {
  return Object.freeze([...patterns.keys()]);
}

for (const [patternName, pattern] of Object.entries(BUILTIN_SECRET_PATTERNS)) {
  registerSecretPattern(patternName, pattern);
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/**
 * One alternation of literal needles, longest first so that a secret containing another secret is
 * replaced whole. No `u` flag: matching is by UTF-16 code unit, which is the "exact bytes" comparison
 * of the in-memory string.
 */
function literalMatcher(needles: Iterable<string>): RegExp | undefined {
  const unique = [...new Set(needles)].filter((needle) => needle.length > 0);
  if (unique.length === 0) return undefined;
  unique.sort((a, b) => b.length - a.length);
  return new RegExp(unique.map((needle) => escapeRegExp(needle)).join('|'), 'g');
}

/** JSON string-literal body of `text`: how it appears inside a serialised log line. */
function jsonEscaped(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

interface Matchers {
  readonly key: string;
  /** Registry values as they appear in a JS string. */
  readonly values: RegExp | undefined;
  /** Registry values as they appear in a JS string or inside a JSON string literal. */
  readonly lineValues: RegExp | undefined;
  readonly patterns: readonly RegExp[];
  /** Length of the longest registry value. */
  readonly longest: number;
}

let cached: Matchers | undefined;

function matchers(): Matchers {
  const key = `${redactionRegistry.version}:${patternsVersion}`;
  if (cached?.key === key) return cached;
  const values = redactionRegistry.values();
  cached = {
    key,
    values: literalMatcher(values),
    lineValues: literalMatcher(values.flatMap((value) => [value, jsonEscaped(value)])),
    patterns: [...patterns.values()].map((entry) => entry.pattern),
    longest: values.reduce((max, value) => Math.max(max, value.length), 0),
  };
  return cached;
}

/** Length of the longest registered secret value, in UTF-16 code units. */
export function longestSecretLength(): number {
  return matchers().longest;
}

function applyPatterns(text: string, list: readonly RegExp[]): string {
  let result = text;
  for (const pattern of list) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Replaces every registered secret value, every registered secret pattern and every built-in
 * credential shape in `text` with `[REDACTED]`. Pure and total; this is the redactor to inject into the
 * `@blackwing/errors` problem+json mapper (`redact` option).
 */
export function redactText(text: string): string {
  const { values, patterns: list } = matchers();
  let result = text;
  if (values !== undefined) {
    values.lastIndex = 0;
    result = result.replace(values, REDACTED);
  }
  result = applyPatterns(result, list);
  return redactBuiltinSecrets(result);
}

/**
 * Last-line-of-defence pass over a fully serialised log line: registry values in raw and JSON-escaped
 * form, plus the registered patterns (which cannot cross a JSON string boundary). The built-in URL
 * userinfo rule is deliberately not applied here: on a whole line it could match across two fields.
 * Returns the line unchanged (same reference) when nothing matched.
 */
export function redactSerializedLine(line: string): string {
  const { lineValues, patterns: list } = matchers();
  let result = line;
  if (lineValues !== undefined) {
    lineValues.lastIndex = 0;
    result = result.replace(lineValues, REDACTED);
  }
  result = applyPatterns(result, list);
  return result;
}

/**
 * Key names whose values are always redacted, at any depth. Compared after lower-casing and removing
 * `-`, `_` and spaces, as an exact name or as a suffix (`clientSecret`, `x-auth-token`,
 * `githubApiKey`, `AWS_SECRET_ACCESS_KEY`). `tokens` is not `token`: LLM usage counters such as
 * `inputTokens` stay visible.
 */
const SENSITIVE_KEY_SUFFIXES = Object.freeze([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'signature',
  'privatekey',
  'credentials',
  'secretkey',
  'secretaccesskey',
  'encryptionkey',
  'signingkey',
]);

/** Key names redacted only as the whole (normalised) name: as suffixes they would hit `authority`. */
const SENSITIVE_KEY_NAMES = Object.freeze(['pwd', 'auth', 'jwt']);

/** True when values under `key` must never be logged. */
export function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s]/g, '');
  if (SENSITIVE_KEY_NAMES.includes(normalised)) return true;
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

/**
 * pino `redact.paths` (FOUND-008 requirement 2). pino's wildcard covers exactly one level, so the
 * object walk in `sanitize.ts` also redacts these key names at every depth; the paths stay as the
 * guarantee for anything that reaches pino without passing the walk (child-logger options, custom
 * serializers).
 */
export const REDACT_PATHS: readonly string[] = Object.freeze([
  'password',
  'token',
  'authorization',
  'secret',
  'apiKey',
  'signature',
  'cookie',
  '*.password',
  '*.token',
  '*.authorization',
  '*.secret',
  '*.apiKey',
  '*.signature',
  '*.cookie',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["proxy-authorization"]',
  'headers["x-api-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
]);
