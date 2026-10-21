import { randomUUID } from 'node:crypto';

import { idempotencyKeySchema } from '@blackwing/contracts';
import { serializeErrorForLog } from '@blackwing/errors';

import {
  hashIdempotencyKey,
  idempotencyStorageKey,
  requestFingerprint,
  type FingerprintInput,
} from './fingerprint.js';
import { buildSnapshot, headerSubset, isCacheableStatus } from './snapshot.js';
import { ApiProblemError } from '../errors/problem-errors.js';

import type { IdempotencyMetrics } from './metrics.js';
import type { IdempotencyStore } from './ports.js';
import type { CompletedRecord, StoredResult } from './record.js';
import type { Logger } from '@blackwing/logger';

const MS_PER_SECOND = 1000;
/** How often `acquire` is retried when the key expires between the failed set and the read. */
const MAX_ACQUIRE_ATTEMPTS = 3;
/** `Retry-After` of `409 idempotency_in_progress`: the first request is usually quick. */
const IN_PROGRESS_RETRY_AFTER_S = 1;
/** `Retry-After` of `503 idempotency_unavailable`. */
const UNAVAILABLE_RETRY_AFTER_S = 5;

export interface IdempotencyServiceOptions {
  /** `null` when no store is wired: every idempotent route then fails closed with 503. */
  readonly store: IdempotencyStore | null;
  readonly ttlSeconds: number;
  readonly lockTtlSeconds: number;
  readonly maxBodyBytes: number;
  readonly metrics: IdempotencyMetrics;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly newToken?: () => string;
}

/** The request, as the service needs it. */
export interface BeginInput extends FingerprintInput {
  readonly tenantId: string;
  /** Matched route template (`/v1/runs`). */
  readonly route: string;
  /** The `Idempotency-Key` header as received. */
  readonly key: string | readonly string[] | undefined;
  /** Request-scoped logger (carries `traceId`); defaults to the service logger. Never given the key or the body. */
  readonly logger?: Logger;
}

/** What a request that took the in-flight marker must hand back when its response is ready. */
export interface PendingExecution {
  readonly storageKey: string;
  readonly token: string;
  readonly keyHash: string;
  readonly fingerprint: string;
  readonly route: string;
}

export type BeginOutcome =
  | { readonly kind: 'proceed'; readonly pending: PendingExecution }
  | { readonly kind: 'replay'; readonly result: StoredResult };

/** The response about to be sent, as `onSend` sees it. */
export interface OutgoingResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly payload: unknown;
}

/**
 * Idempotency-Key state machine (API-008): `absent -> in_progress -> completed`, with `in_progress`
 * dropped again for results that must not be cached. The store is the only shared state, so any number
 * of API instances agree on who runs a request.
 *
 * Failing closed (§8): when the store errors, creation is refused with `503 idempotency_unavailable`
 * rather than risk a double create. The trade-off is availability: while Valkey is down no `@Idempotent()`
 * route accepts requests, which is the intended behaviour for run, export and ticket creation.
 */
export class IdempotencyService {
  readonly #opts: IdempotencyServiceOptions;
  readonly #now: () => Date;
  readonly #newToken: () => string;

  constructor(options: IdempotencyServiceOptions) {
    this.#opts = options;
    this.#now = options.now ?? (() => new Date());
    this.#newToken = options.newToken ?? randomUUID;
  }

  /**
   * Admits one request: returns `proceed` (run the handler, then call {@link finish}) or `replay` (send
   * the stored response). Every refusal is an `ApiProblemError`.
   */
  async begin(input: BeginInput): Promise<BeginOutcome> {
    const key = this.#validKey(input.key);
    const store = this.#opts.store;
    if (store === null) throw this.#unavailable('no idempotency store configured');

    const keyHash = hashIdempotencyKey(key);
    const fingerprint = requestFingerprint(input);
    const storageKey = idempotencyStorageKey(input.tenantId, input.route, keyHash);
    const token = this.#newToken();
    const lockTtlMs = this.#opts.lockTtlSeconds * MS_PER_SECOND;
    const route = input.route;
    const log = input.logger ?? this.#opts.logger;

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      let acquired;
      try {
        acquired = await store.acquire(
          storageKey,
          {
            state: 'in_progress',
            keyHash,
            fingerprint,
            token,
            startedAt: this.#now().toISOString(),
          },
          lockTtlMs,
        );
      } catch (error) {
        this.#opts.metrics.storeErrors.inc({ operation: 'acquire' });
        throw this.#unavailable('acquire failed', error);
      }
      if (acquired.acquired) {
        return { kind: 'proceed', pending: { storageKey, token, keyHash, fingerprint, route } };
      }
      const existing = acquired.existing;
      if (existing === null) continue; // expired in between: behaves as a new key

      // A reused key must carry the same request, whatever state the first one is in.
      if (existing.fingerprint !== fingerprint) {
        this.#opts.metrics.conflicts.inc({ route });
        log.warn({ route }, 'idempotency.conflict');
        throw new ApiProblemError('idempotency_conflict', 'Idempotency-Key reused', {
          detail: 'This Idempotency-Key was already used with a different request.',
        });
      }
      if (existing.state === 'in_progress') {
        this.#opts.metrics.inflight.inc({ route });
        log.info({ route }, 'idempotency.in_progress');
        throw new ApiProblemError('idempotency_in_progress', 'Idempotency-Key in progress', {
          detail: 'A request with this Idempotency-Key is still being processed; retry shortly.',
          retryAfterSeconds: IN_PROGRESS_RETRY_AFTER_S,
        });
      }
      if (existing.result.kind === 'omitted') {
        throw new ApiProblemError('idempotency_result_too_large', 'Stored result not replayable', {
          detail:
            `The original request completed with status ${String(existing.result.status)} but its ` +
            'response cannot be replayed; read the resource it created instead of retrying.',
        });
      }
      this.#opts.metrics.hits.inc({ route });
      log.info({ route, status: existing.result.status }, 'idempotency.replay');
      return { kind: 'replay', result: existing.result };
    }
    throw this.#unavailable('key kept expiring during acquire');
  }

  /**
   * Called with the response as it is sent. A cacheable result replaces the marker (completing the
   * request); anything else drops the marker so a retry runs again. Never throws: the response must go
   * out, and a lost marker only widens the retry window to the lock TTL.
   */
  async finish(pending: PendingExecution, response: OutgoingResponse): Promise<void> {
    const store = this.#opts.store;
    if (store === null) return;
    const { storageKey, token } = pending;
    if (!isCacheableStatus(response.status)) {
      await this.#release(store, pending);
      return;
    }
    const snapshot = buildSnapshot({
      status: response.status,
      headers: headerSubset(response.headers),
      payload: response.payload,
      maxBodyBytes: this.#opts.maxBodyBytes,
    });
    const record: CompletedRecord = {
      state: 'completed',
      keyHash: pending.keyHash,
      fingerprint: pending.fingerprint,
      result:
        snapshot.kind === 'stored'
          ? snapshot.result
          : { kind: 'omitted', status: response.status, reason: snapshot.reason },
      completedAt: this.#now().toISOString(),
    };
    try {
      const stored = await store.complete(
        storageKey,
        token,
        record,
        this.#opts.ttlSeconds * MS_PER_SECOND,
      );
      if (!stored) {
        this.#opts.metrics.storeErrors.inc({ operation: 'complete' });
        this.#opts.logger.warn({ route: pending.route }, 'idempotency.lock_lost');
      }
    } catch (error) {
      this.#opts.metrics.storeErrors.inc({ operation: 'complete' });
      this.#opts.logger.error(
        { route: pending.route, err: serializeErrorForLog(error) },
        'idempotency.store_failed',
      );
    }
  }

  /** Drops the marker of a request that produced no response worth keeping (best effort). */
  async abandon(pending: PendingExecution): Promise<void> {
    const store = this.#opts.store;
    if (store !== null) await this.#release(store, pending);
  }

  async #release(store: IdempotencyStore, pending: PendingExecution): Promise<void> {
    try {
      await store.release(pending.storageKey, pending.token);
    } catch (error) {
      this.#opts.metrics.storeErrors.inc({ operation: 'release' });
      this.#opts.logger.error(
        { route: pending.route, err: serializeErrorForLog(error) },
        'idempotency.store_failed',
      );
    }
  }

  #validKey(header: string | readonly string[] | undefined): string {
    if (header === undefined || (typeof header === 'string' && header.trim() === ''))
      throw new ApiProblemError('idempotency_key_required', 'Idempotency-Key required', {
        detail: 'This operation requires an Idempotency-Key header.',
      });
    const parsed = typeof header === 'string' ? idempotencyKeySchema.safeParse(header) : undefined;
    if (!parsed?.success)
      throw new ApiProblemError('bad_request', 'Invalid Idempotency-Key', {
        detail: 'Idempotency-Key must be a single value of 8 to 255 visible ASCII characters.',
      });
    return parsed.data;
  }

  #unavailable(why: string, cause?: unknown): ApiProblemError {
    this.#opts.logger.error(
      { why, ...(cause === undefined ? {} : { err: serializeErrorForLog(cause) }) },
      'idempotency.unavailable',
    );
    return new ApiProblemError('idempotency_unavailable', 'Idempotency store unavailable', {
      detail: 'Requests that need an Idempotency-Key cannot be accepted right now; retry later.',
      retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_S,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
