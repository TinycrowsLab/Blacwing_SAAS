import { isMarkedSecret, markSecret, unmarkSecret } from '@blackwing/config';

/**
 * Per-operation secret-value registry (SESSION-002, §8.7). Each resolved value is marked with the
 * process-wide redaction registry of `@blackwing/config`, which the logger reads: every log line that
 * carries the value, in raw or JSON-escaped form, is replaced with `[REDACTED]` by the pino serializer.
 *
 * Several operations may hold the same value at once, so every acquisition is counted and the mark is
 * removed only when the last holder releases it. A value that was already marked elsewhere (a
 * configuration secret) is never unmarked by an operation. `release` is idempotent per acquisition.
 *
 * The same registry is exposed to SESSION-012 so the gateway's redaction set can be fed from it.
 */
export interface SecretRedactionRegistry {
  /** Marks `value` for redaction until the returned function is called. Returns the release function. */
  acquire(value: string): () => void;
  /** Whether `value` is currently held by at least one operation (or was marked elsewhere). */
  has(value: string): boolean;
  /** Number of distinct values held by operations of this registry right now. */
  readonly size: number;
}

interface Hold {
  count: number;
  /** False when the value was already marked before the first acquisition; then it is never unmarked here. */
  readonly owned: boolean;
}

export function createSecretRedactionRegistry(): SecretRedactionRegistry {
  const holds = new Map<string, Hold>();

  return {
    acquire(value) {
      const existing = holds.get(value);
      if (existing !== undefined) {
        existing.count += 1;
      } else {
        const owned = !isMarkedSecret(value);
        markSecret(value);
        holds.set(value, { count: 1, owned });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const hold = holds.get(value);
        if (hold === undefined) return;
        hold.count -= 1;
        if (hold.count > 0) return;
        holds.delete(value);
        if (hold.owned) unmarkSecret(value);
      };
    },
    has: (value) => isMarkedSecret(value),
    get size() {
      return holds.size;
    },
  };
}
