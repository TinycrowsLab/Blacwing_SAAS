/** In-memory counter of client-side API errors by `code` (CONSOLE-005). No PII, never sent anywhere by itself. */
export interface ApiErrorMetrics {
  /** Counts one `api_error` with this code. */
  readonly record: (code: string) => void;
  /** Counts so far, keyed by code. */
  readonly snapshot: () => Readonly<Record<string, number>>;
  readonly reset: () => void;
}

export function createApiErrorMetrics(): ApiErrorMetrics {
  const counts = new Map<string, number>();
  return {
    record: (code) => {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    },
    snapshot: () => Object.fromEntries(counts),
    reset: () => {
      counts.clear();
    },
  };
}
