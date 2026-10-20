// node-postgres pools for the two Blackwing roles (DB-001, CONTEXT_PACK §7, §8.6).
//
// `ObservedPool` adds what plain `pg.Pool` lacks: a typed `DbUnavailableError` when no connection can
// be had (pool exhausted past the acquire timeout, or the server unreachable), `db.pool.*` structured
// logs without credentials, pool gauges, and a handled `error` event so a dropped idle connection is
// discarded (and later replaced) instead of crashing the process.

import pg from 'pg';

import { AppError, type AppErrorOptions } from '@blackwing/errors';

import type { DbConnectionConfig } from './env.js';
import type { Logger } from '@blackwing/logger';

/** Which role a pool connects as: `app` (runtime, RLS subject) or `owner` (migrations only). */
export type PoolName = 'app' | 'owner';

/** Why a connection could not be obtained. */
export type DbUnavailableReason = 'pool_exhausted' | 'connection_failed' | 'pool_closed';

/** `DB_UNAVAILABLE` (503, retryable): the database cannot serve this request right now. */
export class DbUnavailableError extends AppError {
  declare readonly code: 'DB_UNAVAILABLE';
  readonly reason: DbUnavailableReason;
  readonly pool: PoolName;

  constructor(
    reason: DbUnavailableReason,
    pool: PoolName,
    options: Pick<AppErrorOptions, 'cause'> = {},
  ) {
    super('DB_UNAVAILABLE', `database unavailable (${reason}, pool ${pool})`, options);
    this.reason = reason;
    this.pool = pool;
  }
}

/** Gauge hooks (OBS wires these to Prometheus; the default is a no-op). */
export interface DbPoolMetrics {
  /** `db_pool_in_use{pool}`: connections checked out. */
  poolInUse(pool: PoolName, value: number): void;
  /** `db_pool_size{pool}`: open connections (idle + in use). */
  poolSize(pool: PoolName, value: number): void;
}

const NOOP_METRICS: DbPoolMetrics = { poolInUse: () => undefined, poolSize: () => undefined };

/** The logger surface pools need (satisfied by `@blackwing/logger`). */
export type DbLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

/** Options for {@link createPool}. */
export interface CreatePoolOptions {
  readonly logger: DbLogger;
  readonly metrics?: DbPoolMetrics;
  /** Sent as `application_name`, so the role and process show up in `pg_stat_activity`. */
  readonly applicationName?: string;
}

type ConnectCallback = (
  err: Error | undefined,
  client: pg.PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

const ACQUIRE_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
const ENDED_MESSAGE = 'Cannot use a pool after calling end on the pool';

/** Error fields that are safe to log: never the message of a connection string or a password. */
function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const code = (error as { code?: unknown }).code;
  return { errorType: error.name, ...(typeof code === 'string' ? { errorCode: code } : {}) };
}

/** A `pg.Pool` that reports exhaustion, failures and its size, and fails with typed errors. */
export class ObservedPool extends pg.Pool {
  readonly poolName: PoolName;
  readonly #logger: DbLogger;
  readonly #metrics: DbPoolMetrics;
  readonly #max: number;
  #exhausted = false;

  constructor(config: pg.PoolConfig & { max: number }, name: PoolName, options: CreatePoolOptions) {
    super(config);
    this.poolName = name;
    this.#logger = options.logger;
    this.#metrics = options.metrics ?? NOOP_METRICS;
    this.#max = config.max;
    this.on('connect', () => {
      this.#logger.info(this.#fields(), 'db.pool.connect');
      this.#gauges();
    });
    this.on('acquire', () => {
      this.#gauges();
    });
    this.on('release', () => {
      if (this.waitingCount === 0) this.#exhausted = false;
      this.#gauges();
    });
    this.on('remove', () => {
      this.#gauges();
    });
    // An idle client lost its connection (server restart, network drop). pg removes it from the
    // pool; the next checkout opens a fresh one. Without this handler the process would crash.
    this.on('error', (error) => {
      this.#logger.warn({ ...this.#fields(), ...errorFields(error) }, 'db.pool.error');
    });
  }

  #fields(): { pool: PoolName; waiting: number; size: number; idle: number } {
    return {
      pool: this.poolName,
      waiting: this.waitingCount,
      size: this.totalCount,
      idle: this.idleCount,
    };
  }

  #gauges(): void {
    this.#metrics.poolSize(this.poolName, this.totalCount);
    this.#metrics.poolInUse(this.poolName, this.totalCount - this.idleCount);
  }

  #noteDemand(): void {
    if (this.totalCount >= this.#max && this.idleCount === 0 && !this.#exhausted) {
      this.#exhausted = true;
      this.#logger.warn({ ...this.#fields(), waiting: this.waitingCount + 1 }, 'db.pool.exhausted');
    }
  }

  #translate(error: unknown): DbUnavailableError {
    if (error instanceof DbUnavailableError) return error;
    const message = error instanceof Error ? error.message : '';
    const reason: DbUnavailableReason =
      message === ACQUIRE_TIMEOUT_MESSAGE && this.totalCount >= this.#max
        ? 'pool_exhausted'
        : message === ENDED_MESSAGE
          ? 'pool_closed'
          : 'connection_failed';
    if (reason === 'connection_failed') {
      this.#logger.warn({ ...this.#fields(), ...errorFields(error) }, 'db.pool.error');
    }
    return new DbUnavailableError(reason, this.poolName, { cause: error });
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | undefined {
    this.#noteDemand();
    if (callback === undefined) {
      return super.connect().catch((error: unknown) => {
        throw this.#translate(error);
      });
    }
    super.connect((error, client, done) => {
      callback(error instanceof Error ? this.#translate(error) : undefined, client, done);
    });
    return undefined;
  }
}

/** node-postgres TLS settings for a mode. `require` verifies the certificate too (see env.ts). */
function sslFor(config: DbConnectionConfig): pg.PoolConfig['ssl'] {
  return config.sslMode === 'disable' ? false : { rejectUnauthorized: true };
}

/**
 * Creates the pool for `name`. Per-connection settings (`search_path`) go in the startup `options`,
 * so every pooled connection carries them, never a per-query `SET`.
 */
export function createPool(
  config: DbConnectionConfig,
  name: PoolName,
  options: CreatePoolOptions,
): ObservedPool {
  return new ObservedPool(
    {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: sslFor(config),
      max: config.poolMax,
      connectionTimeoutMillis: config.acquireTimeoutMs,
      idleTimeoutMillis: config.idleTimeoutMs,
      application_name: options.applicationName ?? `blackwing-${name}`,
      options: '-c search_path=public',
    },
    name,
    options,
  );
}
