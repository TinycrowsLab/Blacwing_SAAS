// Database connection settings (DB-001), parsed through @blackwing/config.
//
// Two separate schemas on purpose: runtime apps parse `appDbEnvSchema`, which never reads the owner
// keys, so owner credentials are never loaded (or even marked as secrets) by an app process. Only the
// migrate job parses `ownerDbEnvSchema` (through `@blackwing/db/owner`).

import { z } from 'zod';

import {
  type EnvSource,
  loadConfig,
  type LoadConfigOptions,
  NODE_ENVS,
  type Secret,
  zDurationMs,
  zPort,
  zSecret,
  zString,
} from '@blackwing/config';

/** The role names of `roles.sql`. The dev stack logs in as `bw_migrator`, a member of the owner. */
export const DB_ROLES = Object.freeze({ owner: 'bw_owner', app: 'bw_app' } as const);

/**
 * `disable`: plaintext (development/test only). `require` and `verify-full`: TLS with certificate
 * verification. node-postgres treats `require` as `verify-full`, and so do we: an unverified TLS
 * connection is never offered.
 */
export const PG_SSL_MODES = ['disable', 'require', 'verify-full'] as const;
export type PgSslMode = (typeof PG_SSL_MODES)[number];

/** Environments where a plaintext database connection is refused. */
const TLS_REQUIRED_IN: ReadonlySet<string> = new Set(['staging', 'production']);

export const DEFAULT_PG_PORT = 5432;
export const DEFAULT_PG_DATABASE = 'blackwing';
export const DEFAULT_PG_POOL_MAX = 10;
/** How long a caller waits for a pooled connection (or a new one) before `DbUnavailableError`. */
export const DEFAULT_PG_ACQUIRE_TIMEOUT_MS = 5_000;
/** Idle connections are closed after this long. */
export const DEFAULT_PG_IDLE_TIMEOUT_MS = 30_000;

/** Upper bound on `PG_POOL_MAX`: well below the server's `max_connections`. */
const MAX_PG_POOL_MAX = 200;

const poolMax = zString({ trim: true }).pipe(
  z.coerce.number<string>().int().min(1).max(MAX_PG_POOL_MAX),
);
const positiveMs = zDurationMs().refine((ms) => ms > 0, 'must be greater than zero');

/** Default `DB_STATEMENT_TIMEOUT_MS`: a statement running longer is cancelled by Postgres (DB-007). */
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 15_000;
/** Default `DB_IDLE_TX_TIMEOUT_MS`: an open transaction that sits idle longer is aborted. */
export const DEFAULT_DB_IDLE_TX_TIMEOUT_MS = 30_000;
/** Default `DB_LOCK_TIMEOUT_MS`: waiting longer than this for a row or table lock fails the statement. */
export const DEFAULT_DB_LOCK_TIMEOUT_MS = 5_000;
/** Default `DB_SLOW_QUERY_MS`: queries at or above this duration log `db.query.slow`. */
export const DEFAULT_DB_SLOW_QUERY_MS = 500;
/** Upper bound on the timeout settings: Postgres stores them as a 32-bit millisecond integer. */
const MAX_DB_TIMEOUT_MS = 2_147_483_647;

const sharedShape = {
  NODE_ENV: z.enum(NODE_ENVS),
  PGHOST: zString({ trim: true }),
  PGPORT: zPort().default(DEFAULT_PG_PORT),
  PGDATABASE: zString({ trim: true }).default(DEFAULT_PG_DATABASE),
  PG_POOL_MAX: poolMax.default(DEFAULT_PG_POOL_MAX),
  PG_SSLMODE: z.enum(PG_SSL_MODES).optional(),
  PG_ACQUIRE_TIMEOUT: positiveMs.default(DEFAULT_PG_ACQUIRE_TIMEOUT_MS),
  PG_IDLE_TIMEOUT: positiveMs.default(DEFAULT_PG_IDLE_TIMEOUT_MS),
} as const;

/**
 * Query guardrails of the runtime pool (DB-007). Applied to every connection of the app pool as
 * startup settings, so they hold for pooled connections and transactions alike. The migrate job's
 * owner pool gets none (migrations may legitimately run long).
 */
export interface QueryGuardConfig {
  /** `statement_timeout`: a statement running longer is cancelled (SQLSTATE 57014). */
  readonly statementTimeoutMs: number;
  /** `idle_in_transaction_session_timeout`: an idle open transaction is terminated. */
  readonly idleTxTimeoutMs: number;
  /** `lock_timeout`: how long a statement may wait for a lock. */
  readonly lockTimeoutMs: number;
  /** Queries at or above this many milliseconds are logged as `db.query.slow`. */
  readonly slowQueryMs: number;
}

/** Resolved connection settings for one role. */
export interface DbConnectionConfig {
  readonly nodeEnv: (typeof NODE_ENVS)[number];
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: Secret;
  readonly poolMax: number;
  readonly sslMode: PgSslMode;
  readonly acquireTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

/** Runtime (app role) connection settings: the role's connection plus its query guardrails. */
export interface AppDbConnectionConfig extends DbConnectionConfig {
  readonly guards: QueryGuardConfig;
}

const timeoutMs = zString({ trim: true }).pipe(
  z.coerce.number<string>().int().min(1).max(MAX_DB_TIMEOUT_MS),
);

const queryGuardShape = {
  DB_STATEMENT_TIMEOUT_MS: timeoutMs.default(DEFAULT_DB_STATEMENT_TIMEOUT_MS),
  DB_IDLE_TX_TIMEOUT_MS: timeoutMs.default(DEFAULT_DB_IDLE_TX_TIMEOUT_MS),
  DB_LOCK_TIMEOUT_MS: timeoutMs.default(DEFAULT_DB_LOCK_TIMEOUT_MS),
  DB_SLOW_QUERY_MS: zString({ trim: true })
    .pipe(z.coerce.number<string>().int().min(0).max(MAX_DB_TIMEOUT_MS))
    .default(DEFAULT_DB_SLOW_QUERY_MS),
} as const;

interface SharedParsed {
  NODE_ENV: (typeof NODE_ENVS)[number];
  PGHOST: string;
  PGPORT: number;
  PGDATABASE: string;
  PG_POOL_MAX: number;
  PG_SSLMODE?: PgSslMode | undefined;
  PG_ACQUIRE_TIMEOUT: number;
  PG_IDLE_TIMEOUT: number;
}

function resolveSslMode(env: SharedParsed): PgSslMode {
  return env.PG_SSLMODE ?? (TLS_REQUIRED_IN.has(env.NODE_ENV) ? 'require' : 'disable');
}

function checkTls(env: SharedParsed, ctx: z.RefinementCtx): void {
  if (TLS_REQUIRED_IN.has(env.NODE_ENV) && env.PG_SSLMODE === 'disable') {
    ctx.addIssue({
      code: 'custom',
      path: ['PG_SSLMODE'],
      message: `plaintext database connections are refused in ${env.NODE_ENV}`,
    });
  }
}

function toConnection(env: SharedParsed, user: string, password: Secret): DbConnectionConfig {
  return {
    nodeEnv: env.NODE_ENV,
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user,
    password,
    poolMax: env.PG_POOL_MAX,
    sslMode: resolveSslMode(env),
    acquireTimeoutMs: env.PG_ACQUIRE_TIMEOUT,
    idleTimeoutMs: env.PG_IDLE_TIMEOUT,
  };
}

/**
 * Runtime (app role) settings. Never reads `PG_OWNER_*`. The password has no default, and the app
 * user may never be the owner role: the runtime connection must stay an RLS subject (§8.6).
 */
export const appDbEnvSchema = z
  .object({
    ...sharedShape,
    ...queryGuardShape,
    PG_APP_USER: zString({ trim: true }).default(DB_ROLES.app),
    PG_APP_PASSWORD: zSecret(),
  })
  .superRefine((env, ctx) => {
    checkTls(env, ctx);
    if (env.PG_APP_USER === DB_ROLES.owner) {
      ctx.addIssue({
        code: 'custom',
        path: ['PG_APP_USER'],
        message: 'the runtime role must not be the schema owner',
      });
    }
  })
  .transform((env): AppDbConnectionConfig => ({
    ...toConnection(env, env.PG_APP_USER, env.PG_APP_PASSWORD),
    guards: {
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
      idleTxTimeoutMs: env.DB_IDLE_TX_TIMEOUT_MS,
      lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
      slowQueryMs: env.DB_SLOW_QUERY_MS,
    },
  }));

/** Migration (owner role) settings: only the migrate job parses these. */
export const ownerDbEnvSchema = z
  .object({
    ...sharedShape,
    PG_OWNER_USER: zString({ trim: true }).default(DB_ROLES.owner),
    PG_OWNER_PASSWORD: zSecret(),
  })
  .superRefine((env, ctx) => {
    checkTls(env, ctx);
    if (env.PG_OWNER_USER === DB_ROLES.app) {
      ctx.addIssue({
        code: 'custom',
        path: ['PG_OWNER_USER'],
        message: 'the owner role must not be the runtime role',
      });
    }
  })
  .transform((env) => toConnection(env, env.PG_OWNER_USER, env.PG_OWNER_PASSWORD));

/**
 * Parses the runtime database settings. Throws `ConfigValidationError` (`CONFIG_INVALID`, an
 * `AppError`) naming the keys only, never their values.
 */
export function loadAppDbConfig(
  source?: EnvSource,
  options?: LoadConfigOptions,
): Readonly<AppDbConnectionConfig> {
  return loadConfig(appDbEnvSchema, source, options);
}

/** Parses the owner (migration) settings. Same failure mode as {@link loadAppDbConfig}. */
export function loadOwnerDbConfig(
  source?: EnvSource,
  options?: LoadConfigOptions,
): Readonly<DbConnectionConfig> {
  return loadConfig(ownerDbEnvSchema, source, options);
}

/** Transaction isolation levels `withTenant`/`withSystem` accept (never `read uncommitted`). */
export const TX_ISOLATION_LEVELS = ['read committed', 'repeatable read', 'serializable'] as const;
export type TxIsolation = (typeof TX_ISOLATION_LEVELS)[number];

export const DEFAULT_DB_TX_MAX_RETRIES = 3;
export const DEFAULT_DB_TX_ISOLATION: TxIsolation = 'read committed';
/** Upper bound on `DB_TX_MAX_RETRIES`: a transaction that fails this often should surface, not spin. */
export const MAX_DB_TX_MAX_RETRIES = 10;

/** Transaction settings of the `withTenant` helper (DB-004). */
export interface DbTxConfig {
  readonly maxRetries: number;
  readonly isolation: TxIsolation;
}

/** `DB_TX_MAX_RETRIES` (default 3) and `DB_TX_ISOLATION` (default `read committed`). */
export const dbTxEnvSchema = z
  .object({
    DB_TX_MAX_RETRIES: zString({ trim: true })
      .pipe(z.coerce.number<string>().int().min(0).max(MAX_DB_TX_MAX_RETRIES))
      .default(DEFAULT_DB_TX_MAX_RETRIES),
    DB_TX_ISOLATION: zString({ trim: true })
      .pipe(z.enum(TX_ISOLATION_LEVELS))
      .default(DEFAULT_DB_TX_ISOLATION),
  })
  .transform((env): DbTxConfig => ({
    maxRetries: env.DB_TX_MAX_RETRIES,
    isolation: env.DB_TX_ISOLATION,
  }));

/** Parses the transaction settings. Throws `ConfigValidationError` (`CONFIG_INVALID`) naming keys only. */
export function loadDbTxConfig(
  source?: EnvSource,
  options?: LoadConfigOptions,
): Readonly<DbTxConfig> {
  return loadConfig(dbTxEnvSchema, source, options);
}
