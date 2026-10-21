// The tenant transaction helper (DB-004, CONTEXT_PACK §7, §8.6, §8.8, §8.11): the single, canonical
// doorway for tenant-scoped data access. `withTenant` owns the transaction (BEGIN, transaction-local
// `set_config('app.tenant_id', $1, true)`, the callback, COMMIT or ROLLBACK), so callers never manage a
// transaction themselves and the setting can never outlive it on a pooled connection. Together with the
// RLS policy (DB-003, no `missing_ok`) a request without a tenant context fails closed twice: here,
// before any query, and in the database.
//
// This is the only implementation of `withTenant` in the codebase. The choke-point guard (TENANT-002)
// consumes it; it does not re-implement it. `withSystem` is the one explicit, audited bypass.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';

import { AppError, type AppErrorOptions, TenantContextMissingError } from '@blackwing/errors';
import { createLogger, type Logger } from '@blackwing/logger';

import { type DbTxConfig, loadDbTxConfig, type TxIsolation } from './env.js';
import { toTenantIsolationError } from './rls.js';

import type { Database, Tx } from './client.js';

declare const tenantTxBrand: unique symbol;
declare const systemTxBrand: unique symbol;

/**
 * The transaction handle `withTenant` passes to its callback: a Drizzle transaction whose
 * `app.tenant_id` is set. Data-path code takes a `TenantTx` so the compiler refuses a bare `db`
 * or a handle from `withSystem` (the brand is type-only; the runtime object is the Drizzle one).
 */
export type TenantTx = Tx & { readonly [tenantTxBrand]: true };

/** The handle `withSystem` passes: a transaction with no tenant context (RLS tenant tables stay closed). */
export type SystemTx = Tx & { readonly [systemTxBrand]: true };

/** Postgres SQLSTATEs that mean "run the whole transaction again". */
export const RETRYABLE_PG_CODES: readonly string[] = Object.freeze([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/** Backoff between retries: full jitter on an exponential ceiling. */
const BACKOFF_BASE_MS = 10;
const BACKOFF_CAP_MS = 500;
const CAUSE_DEPTH = 5;
const TENANT_HASH_LENGTH = 12;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** `TX_RETRY_EXHAUSTED` (503, retryable): the transaction kept failing with serialization failures or deadlocks. */
export class TxRetryExhaustedError extends AppError {
  declare readonly code: 'TX_RETRY_EXHAUSTED';
  /** Attempts made (the first run plus the retries). */
  readonly attempts: number;
  /** The SQLSTATE of each failed attempt, in order. */
  readonly codes: readonly string[];

  constructor(
    attempts: number,
    codes: readonly string[],
    options: Pick<AppErrorOptions, 'cause'> = {},
  ) {
    super(
      'TX_RETRY_EXHAUSTED',
      `transaction retries exhausted after ${attempts} attempts`,
      options,
    );
    this.attempts = attempts;
    this.codes = Object.freeze([...codes]);
  }
}

/**
 * `TENANT_CONTEXT_CONFLICT` (500, never retried): code inside a transaction tried to switch to a
 * different tenant context (or to or from the system context). There is no silent re-scoping.
 * The message never names either tenant.
 */
export class TenantContextMismatchError extends AppError {
  declare readonly code: 'TENANT_CONTEXT_CONFLICT';

  constructor(message?: string, options?: Pick<AppErrorOptions, 'cause'>) {
    super(
      'TENANT_CONTEXT_CONFLICT',
      message ?? 'nested transaction requested a different tenant context',
      options,
    );
  }
}

/** Counters (OBS wires these to Prometheus; the default is a no-op). */
export interface DbTxMetrics {
  /** `db_tx_retry_total{code}`: a transaction was re-run after SQLSTATE `code`. */
  txRetry(code: string): void;
  /** `bw_tenant_context_missing_total`: the fail-closed error fired. */
  tenantContextMissing(): void;
}

const NOOP_METRICS: DbTxMetrics = {
  txRetry: () => undefined,
  tenantContextMissing: () => undefined,
};

/** The logger surface the helper needs (satisfied by `@blackwing/logger`). */
export type TxLogger = Pick<Logger, 'debug' | 'warn' | 'error'>;

/** Options shared by {@link withTenant} and {@link withSystem}. */
export interface TxOptions {
  /** Overrides `DB_TX_ISOLATION` for this transaction (helpers that need stronger isolation). */
  readonly isolation?: TxIsolation;
  /** Overrides `DB_TX_MAX_RETRIES`: re-runs after the first attempt. */
  readonly maxRetries?: number;
  /**
   * Aborts the transaction (kill switch, §8.5). Checked before BEGIN, before every retry and before
   * COMMIT: an aborted transaction never commits, so no partial tenant write persists. The callback
   * should hand the signal to its own long-running work. It is never raced against the callback:
   * rolling back under a still-running statement could run it outside this transaction.
   */
  readonly signal?: AbortSignal;
  readonly logger?: TxLogger;
  readonly metrics?: DbTxMetrics;
  /** Milliseconds to wait before retry number `attempt` (1-based). Default: jittered exponential. */
  readonly backoffMs?: (attempt: number) => number;
}

/** An audit event written by {@link withSystem} (§8.8). */
export interface SystemAccessEvent {
  readonly action: 'db.system_access';
  /** `started` before the callback runs, then `succeeded` or `failed`. */
  readonly phase: 'started' | 'succeeded' | 'failed';
  /** Who runs the maintenance path (operator or job identity). */
  readonly actor: string;
  /** Why the tenant-less path is needed. */
  readonly reason: string;
  /** Epoch milliseconds. */
  readonly at: number;
}

/** Writes an audit event. A rejected `started` event stops `withSystem` before any query. */
export type SystemAuditEmitter = (event: SystemAccessEvent) => void | Promise<void>;

/** Options of {@link withSystem}: the audit trail is mandatory. */
export interface WithSystemOptions extends TxOptions {
  readonly audit: SystemAuditEmitter;
  readonly actor: string;
  readonly reason: string;
  /** Clock for the audit events (epoch ms). Default `Date.now`. */
  readonly now?: () => number;
}

interface Scope {
  readonly db: Database;
  /** The tenant UUID, or `null` for the system context. */
  readonly tenantId: string | null;
  readonly tx: Tx;
  /** False once the transaction has ended: an orphaned continuation must not reuse its handle. */
  open: boolean;
}

const scopes = new AsyncLocalStorage<Scope>();

let defaultConfig: Readonly<DbTxConfig> | undefined;
let defaultLogger: TxLogger | undefined;

function resolveConfig(options: TxOptions): DbTxConfig {
  const { maxRetries, isolation } = options;
  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
    throw new RangeError('maxRetries must be a non-negative integer');
  }
  if (maxRetries !== undefined && isolation !== undefined) return { maxRetries, isolation };
  defaultConfig ??= loadDbTxConfig();
  return {
    maxRetries: maxRetries ?? defaultConfig.maxRetries,
    isolation: isolation ?? defaultConfig.isolation,
  };
}

function loggerOf(options: TxOptions): TxLogger {
  defaultLogger ??= createLogger('@blackwing/db');
  return options.logger ?? defaultLogger;
}

/** A short, non-reversible tenant label for logs (§8.7). */
function hashTenant(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, TENANT_HASH_LENGTH);
}

/**
 * Normalises a tenant id to lower-case canonical UUID text or fails closed. Nothing is queried and no
 * transaction is opened before this passes; the value is only ever bound as a parameter afterwards.
 */
function requireTenantId(value: unknown, metrics: DbTxMetrics): string {
  if (value === undefined || value === null || value === '') {
    metrics.tenantContextMissing();
    throw new TenantContextMissingError('tenant id is required: refusing to run without a tenant', {
      reason: 'missing',
    });
  }
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) {
    metrics.tenantContextMissing();
    throw new TenantContextMissingError('tenant id is not a UUID: refusing to run', {
      reason: 'invalid_uuid',
    });
  }
  return value.toLowerCase();
}

/** Drizzle wraps driver errors in `DrizzleQueryError` with the pg error as `cause`. */
export function unwrapQueryError(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH; depth += 1) {
    if (typeof (current as { code?: unknown } | null)?.code === 'string') return current;
    const cause = (current as { cause?: unknown } | null)?.cause;
    if (cause === undefined || cause === null) return error;
    current = cause;
  }
  return error;
}

/** SQLSTATE of a Postgres error, looking through Drizzle's query-error wrapper (`cause`). */
function pgErrorCode(error: unknown): string | undefined {
  const code = (unwrapQueryError(error) as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SQLSTATE.test(code) ? code : undefined;
}

function defaultBackoff(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.floor(Math.random() * (ceiling + 1));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      const reason: unknown = signal?.reason;
      reject(
        reason instanceof Error ? reason : new Error('transaction aborted', { cause: reason }),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface RunInput<T> {
  readonly db: Database;
  readonly tenantId: string | null;
  readonly options: TxOptions;
  readonly fn: (tx: Tx) => Promise<T>;
}

/** BEGIN, set the context, run, COMMIT or ROLLBACK, re-running the whole thing on 40001 / 40P01. */
async function runTransaction<T>(input: RunInput<T>): Promise<T> {
  const { db, tenantId, options, fn } = input;
  const { maxRetries, isolation } = resolveConfig(options);
  const logger = loggerOf(options);
  const metrics = options.metrics ?? NOOP_METRICS;
  const backoff = options.backoffMs ?? defaultBackoff;
  const signal = options.signal;
  const label = tenantId === null ? 'system' : hashTenant(tenantId);
  const failures: string[] = [];

  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    logger.debug({ tenantId: label, attempt }, 'db.tx.begin');
    try {
      const result = await db.transaction(
        async (tx) => {
          const scope: Scope = { db, tenantId, tx, open: true };
          try {
            if (tenantId !== null) {
              // Transaction-local (third argument true) and parameterised: never interpolated, and
              // gone at COMMIT/ROLLBACK, so a pooled connection cannot carry it to the next request.
              await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
            }
            signal?.throwIfAborted();
            const value = await scopes.run(scope, () => fn(tx));
            signal?.throwIfAborted();
            return value;
          } finally {
            scope.open = false;
          }
        },
        { isolationLevel: isolation },
      );
      logger.debug({ tenantId: label, attempt }, 'db.tx.commit');
      return result;
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === undefined || !RETRYABLE_PG_CODES.includes(code)) {
        logger.debug({ tenantId: label, attempt, code }, 'db.tx.rollback');
        // A missing/garbled tenant setting or a WITH CHECK violation surfaces as its AppError (DB-003).
        throw toTenantIsolationError(unwrapQueryError(error)) ?? error;
      }
      failures.push(code);
      if (failures.length > maxRetries) {
        logger.error({ tenantId: label, attempt, codes: failures }, 'db.tx.retry_exhausted');
        throw new TxRetryExhaustedError(attempt, failures, { cause: error });
      }
      metrics.txRetry(code);
      logger.warn({ tenantId: label, attempt, codes: failures }, 'db.tx.retry');
      await sleep(backoff(attempt), signal);
    }
  }
}

function withSpan<T>(name: string, tenantId: string | null, run: () => Promise<T>): Promise<T> {
  return trace.getTracer('@blackwing/db').startActiveSpan(name, async (span: Span) => {
    if (tenantId !== null) span.setAttribute('tenant.id', tenantId);
    try {
      return await run();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** The scope of a live enclosing transaction, if the caller is inside one. */
function activeScope(): Scope | undefined {
  const scope = scopes.getStore();
  return scope?.open === true ? scope : undefined;
}

/**
 * Runs `fn` in a transaction scoped to `tenantId`: `BEGIN`, `SELECT set_config('app.tenant_id', $1,
 * true)`, `fn(tx)`, `COMMIT`, or `ROLLBACK` if `fn` throws. This is the only doorway to tenant data
 * (§7); RLS (DB-003) then shows `fn` only that tenant's rows.
 *
 * - A missing id throws `TenantContextMissingError` (`meta.reason === 'missing'`) and a non-UUID the
 *   same error (`'invalid_uuid'`), both before the transaction opens.
 * - Serialization failures (`40001`) and deadlocks (`40P01`) re-run the whole transaction up to
 *   `DB_TX_MAX_RETRIES` times with jittered backoff, then throw `TxRetryExhaustedError`. `fn` may
 *   therefore run more than once: it must be idempotent, or do database work only.
 * - A nested call for the same tenant (and database) reuses the open transaction. A nested call for a
 *   different tenant, or from inside `withSystem`, throws `TenantContextMismatchError`.
 * - Queries on any other client or pool inside `fn` are outside the transaction and unsupported.
 */
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  const id = requireTenantId(tenantId, options.metrics ?? NOOP_METRICS);
  const outer = activeScope();
  if (outer !== undefined) {
    if (outer.tenantId !== id) throw new TenantContextMismatchError();
    if (outer.db === db) {
      options.signal?.throwIfAborted();
      return fn(outer.tx as TenantTx);
    }
  }
  return withSpan('db.withTenant', id, () =>
    runTransaction({ db, tenantId: id, options, fn: (tx) => fn(tx as TenantTx) }),
  );
}

/**
 * Runs `fn` in a transaction with no tenant context, for rare platform-operator and maintenance
 * paths. It must be called explicitly, never for ordinary request handling. The `started` audit event
 * is written first and a failing emitter stops the call before any query (§8.8); a `succeeded` or
 * `failed` event follows (best effort, logged if the emitter fails). Tenant tables stay closed to it:
 * RLS has no tenant, so only non-tenant tables are reachable. Inside `withTenant` it throws
 * `TenantContextMismatchError`: a tenant request can never fall back to the system context.
 */
export async function withSystem<T>(
  db: Database,
  fn: (tx: SystemTx) => Promise<T>,
  options: WithSystemOptions,
): Promise<T> {
  const { audit, actor, reason } = options;
  if (typeof audit !== 'function' || actor.trim() === '' || reason.trim() === '') {
    throw new TypeError('withSystem requires an audit emitter, an actor and a reason');
  }
  const outer = activeScope();
  if (outer !== undefined && outer.tenantId !== null) throw new TenantContextMismatchError();
  const now = options.now ?? Date.now;
  const emit = (phase: SystemAccessEvent['phase']): void | Promise<void> =>
    audit({ action: 'db.system_access', phase, actor, reason, at: now() });

  await emit('started');
  const finish = async (phase: 'succeeded' | 'failed'): Promise<void> => {
    try {
      await emit(phase);
    } catch (error) {
      loggerOf(options).error(
        { phase, errorType: error instanceof Error ? error.name : typeof error },
        'db.system_access.audit_failed',
      );
    }
  };

  try {
    const result =
      outer?.db === db
        ? await fn(outer.tx as SystemTx)
        : await withSpan('db.withSystem', null, () =>
            runTransaction({ db, tenantId: null, options, fn: (tx) => fn(tx as SystemTx) }),
          );
    await finish('succeeded');
    return result;
  } catch (error) {
    await finish('failed');
    throw error;
  }
}
