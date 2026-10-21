import type { CompletedRecord, IdempotencyRecord, InProgressRecord } from './record.js';

/** Result of trying to take the in-flight marker for a key. */
export type AcquireResult =
  | { readonly acquired: true }
  /** `existing` is null when the key expired between the failed set and the read: retry the acquire. */
  | { readonly acquired: false; readonly existing: IdempotencyRecord | null };

/**
 * Storage for idempotency records (API-008). The production adapter is Valkey
 * ({@link ValkeyIdempotencyStore}); a failure of any method means "the store is unavailable" and the
 * service fails closed. Every method works on one fully-qualified key, which already carries the tenant.
 */
export interface IdempotencyStore {
  /** `SET key record NX PX lockTtlMs`; when the key exists, returns its record. */
  acquire(key: string, record: InProgressRecord, lockTtlMs: number): Promise<AcquireResult>;
  /**
   * Replaces the `in_progress` record owned by `token` with `record` for `ttlMs`. Returns false when
   * the lock was lost (expired, or taken over by a later retry); nothing is written then.
   */
  complete(key: string, token: string, record: CompletedRecord, ttlMs: number): Promise<boolean>;
  /** Deletes the `in_progress` record owned by `token` so a genuine retry can proceed. */
  release(key: string, token: string): Promise<boolean>;
}
