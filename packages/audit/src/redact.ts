import { redactBuiltinSecrets, REDACTED, type Redactor } from '@blackwing/errors';

/**
 * Redaction applied to every audit event before it is hashed (CONTEXT_PACK §8.7). The ledger is
 * append-only, so a secret that gets in can never be removed; this runs in the helper so that no
 * producer has to remember it.
 *
 * Three layers, all always on:
 * 1. the injected registry redactor (exact known secret values, from `@blackwing/logger`/SECRETS),
 *    which fails closed: if it throws, the whole string is replaced;
 * 2. the credential patterns `@blackwing/errors` already knows (bwk_/bw_pat_/bw_run_ tokens, bearer
 *    values, URL userinfo, PEM private keys) plus cloud and VCS key shapes (interim set until the
 *    SECRETS registry covers them);
 * 3. keys that name a secret (`password`, `apiKey`, `authorization`, ...): the value is replaced
 *    whatever it looks like.
 */

/** Deepest nesting redacted; anything deeper is refused (also bounds recursion on cyclic input). */
export const REDACTION_MAX_DEPTH = 32;

const EXTRA_RULES: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, replacement: REDACTED },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: REDACTED,
  },
];

/** Lower-cased key with separators removed, matched by suffix: `client_secret`, `dbPassword`. */
const SECRET_KEY_SUFFIXES = [
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
] as const;

/** Whether `key` names a secret value. A bare `token` counts; `tokenId` and `tokenRef` do not. */
export function isSecretKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalised === 'token' || SECRET_KEY_SUFFIXES.some((suffix) => normalised.endsWith(suffix))
  );
}

/** The text redactor: registry first (fail closed), then the pattern layers. */
export function createTextRedactor(registry?: Redactor): (text: string) => string {
  return (text) => {
    let result = text;
    if (registry !== undefined) {
      try {
        const redacted: unknown = registry(text);
        result = typeof redacted === 'string' ? redacted : REDACTED;
      } catch {
        return REDACTED;
      }
    }
    result = redactBuiltinSecrets(result);
    for (const rule of EXTRA_RULES) result = result.replace(rule.pattern, rule.replacement);
    return result;
  };
}

/** Raised for input that cannot be redacted safely (too deep or cyclic). */
export class RedactionDepthError extends Error {
  constructor() {
    super(`value is nested deeper than ${String(REDACTION_MAX_DEPTH)} levels`);
    this.name = 'RedactionDepthError';
  }
}

/**
 * Returns a redacted copy of a JSON-like value. Values that are not JSON (functions, bigint, class
 * instances) are returned untouched for schema validation to reject. Throws
 * {@link RedactionDepthError} past {@link REDACTION_MAX_DEPTH}.
 */
export function redactValue(value: unknown, redactText: (text: string) => string): unknown {
  return walk(value, redactText, 0);
}

function walk(value: unknown, redactText: (text: string) => string, depth: number): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= REDACTION_MAX_DEPTH) throw new RedactionDepthError();
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map((item) => walk(item, redactText, depth + 1));
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const redactedKey = redactText(key);
    const redacted: unknown =
      isSecretKey(key) && item !== null && item !== undefined
        ? REDACTED
        : walk(item, redactText, depth + 1);
    // defineProperty, not assignment: a `__proto__` key must stay a plain member for validation to reject.
    Object.defineProperty(output, redactedKey, {
      value: redacted,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return output;
}
