import type { AcquireResult, IdempotencyStore } from './ports.js';
import type { CompletedRecord, IdempotencyRecord, InProgressRecord } from './record.js';

interface Entry {
  readonly record: IdempotencyRecord;
  readonly expiresAt: number;
}

/**
 * In-process {@link IdempotencyStore} for unit tests and a Valkey-less dev API. `acquire` has no
 * `await` before the check-and-set, so on one event loop it is as atomic as `SET NX`. Expiry follows an
 * injectable clock. It cannot dedupe across API instances, so production must use Valkey.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  acquire(key: string, record: InProgressRecord, lockTtlMs: number): Promise<AcquireResult> {
    const existing = this.#live(key);
    if (existing !== undefined)
      return Promise.resolve({ acquired: false, existing: existing.record });
    this.#entries.set(key, { record, expiresAt: this.#now() + lockTtlMs });
    return Promise.resolve({ acquired: true });
  }

  complete(key: string, token: string, record: CompletedRecord, ttlMs: number): Promise<boolean> {
    if (!this.#owns(key, token)) return Promise.resolve(false);
    this.#entries.set(key, { record, expiresAt: this.#now() + ttlMs });
    return Promise.resolve(true);
  }

  release(key: string, token: string): Promise<boolean> {
    if (!this.#owns(key, token)) return Promise.resolve(false);
    this.#entries.delete(key);
    return Promise.resolve(true);
  }

  /** Test helper: the live record under a key. */
  peek(key: string): IdempotencyRecord | undefined {
    return this.#live(key)?.record;
  }

  /** Test helper: every live key. */
  keys(): readonly string[] {
    return [...this.#entries.keys()].filter((key) => this.#live(key) !== undefined);
  }

  #live(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  #owns(key: string, token: string): boolean {
    const record = this.#live(key)?.record;
    return record?.state === 'in_progress' && record.token === token;
  }
}
