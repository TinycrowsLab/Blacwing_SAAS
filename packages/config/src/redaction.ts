import type { z } from "zod";

/**
 * A configuration value that must never appear in logs, errors, model prompts or sandboxes
 * (CONTEXT_PACK §8.7). The brand is type-only; the runtime guarantee comes from the redaction
 * registry below, which every `zSecret()`/`zSecretUrl()` value is added to when it is parsed.
 */
export type Secret = string & z.$brand<"Secret">;

/** Read-only view of the redaction registry. `@blackwing/logger` (FOUND-008) reads it. */
export interface RedactionRegistry {
  /** True when `value` is a registered secret (exact string comparison, no normalisation). */
  has(value: string): boolean;
  /** Frozen snapshot of every registered secret value, in registration order. */
  values(): readonly string[];
  /** Number of registered secret values. */
  readonly size: number;
  /**
   * Increments whenever the set changes, so a reader can cache a compiled matcher and rebuild it only
   * when the version moves.
   */
  readonly version: number;
}

const secrets = new Set<string>();
let registryVersion = 0;

/**
 * Registers `value` for value-based redaction and returns it branded as a {@link Secret}.
 *
 * The value is stored verbatim: no trimming and no Unicode normalisation, so the logger compares the
 * exact code units it was given. An empty string is never registered: it cannot leak anything, and
 * an empty needle would match every position of every log line.
 */
export function markSecret(value: string): Secret {
  if (value.length > 0 && !secrets.has(value)) {
    secrets.add(value);
    registryVersion += 1;
  }
  return value as Secret;
}

/**
 * Removes `value` from the registry (for example a revoked short-lived credential). Returns whether
 * it was registered.
 */
export function unmarkSecret(value: string): boolean {
  const removed = secrets.delete(value);
  if (removed) {
    registryVersion += 1;
  }
  return removed;
}

/** True when `value` is a registered secret. */
export function isMarkedSecret(value: string): boolean {
  return secrets.has(value);
}

/** The process-wide redaction registry. */
export const redactionRegistry: RedactionRegistry = Object.freeze({
  has: isMarkedSecret,
  values: (): readonly string[] => Object.freeze([...secrets]),
  get size(): number {
    return secrets.size;
  },
  get version(): number {
    return registryVersion;
  },
});
