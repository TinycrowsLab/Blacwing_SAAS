import { TOOL_AUDIT_SUMMARY_MAX } from '@blackwing/contracts';
import { REDACTED, redactBuiltinSecrets } from '@blackwing/errors';

const MAX_DEPTH = 6;
const MAX_NODES = 500;
const MASK = REDACTED;
const FAILED = '[summary unavailable]';
/** Cloud and VCS key shapes beyond the `@blackwing/errors` patterns; mirrors `@blackwing/audit` (not importable here). */
const EXTRA_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

/**
 * Key names whose value is a secret, matched on the lower-cased key with separators removed.
 * Mirrors `isSecretKey` in `@blackwing/audit`, which sandbox code may not import (§8.6).
 */
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
];

function isSecretKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalised === 'token' || SECRET_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

function redactText(text: string): string {
  return EXTRA_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, REDACTED),
    redactBuiltinSecrets(text),
  );
}

/**
 * A bounded, redacted rendering of a tool call's input for the `tool.invoked` audit event (§8.7, §8.8):
 * values under secret-looking keys are masked, every string passes the built-in credential patterns and
 * then the injected registry redactor (RUNTIME-007), and the result is cut to the contract's limit.
 * Any failure yields a fixed placeholder, never the unredacted input.
 */
export function summariseInput(input: unknown, redact: (text: string) => string): string {
  try {
    let nodes = 0;
    const clean = (value: unknown, depth: number): unknown => {
      nodes += 1;
      if (nodes > MAX_NODES || depth > MAX_DEPTH) return '[truncated]';
      if (typeof value === 'string') return redact(redactText(value));
      if (Array.isArray(value)) return value.map((item: unknown) => clean(item, depth + 1));
      if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            isSecretKey(key) ? MASK : clean(item, depth + 1),
          ]),
        );
      }
      return typeof value === 'bigint' ? value.toString() : value;
    };
    // JSON.stringify of the cleaned copy cannot loop: `clean` bounds depth and node count.
    let text = JSON.stringify(clean(input, 0) ?? null);
    if (text.length > TOOL_AUDIT_SUMMARY_MAX) {
      text = text.slice(0, TOOL_AUDIT_SUMMARY_MAX);
      const last = text.charCodeAt(text.length - 1);
      if (last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX) text = text.slice(0, -1);
    }
    return text;
  } catch {
    return FAILED;
  }
}
