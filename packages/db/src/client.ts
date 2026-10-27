// The runtime Drizzle client on the app-role pool (DB-001). Runtime code only ever gets this pool:
// the owner pool lives behind `@blackwing/db/owner` (migrate job only, enforced by the
// `db-owner-only-from-migrate` boundary rule) and is never created here.

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import { createLogger } from '@blackwing/logger';

import { DB_ROLES, loadAppDbConfig } from './env.js';
import { createPool, type DbLogger, type DbPoolMetrics, type ObservedPool } from './pool.js';
import * as schema from './schema/index.js';

import type { EnvSource } from '@blackwing/config';
import type pg from 'pg';

/** The Drizzle database type every repository takes. */
export type Database = NodePgDatabase<typeof schema>;

/** A Drizzle transaction handle (the argument of `db.transaction(async (tx) => …)`). */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** A runtime database: the Drizzle client and the app-role pool behind it. */
export interface AppDatabase {
  readonly db: Database;
  readonly pool: ObservedPool;
  /** `SELECT 1` on the app pool; never throws. */
  ping(timeoutMs?: number): Promise<DbHealth>;
  /** Ends the pool (graceful shutdown). Idempotent. */
  close(): Promise<void>;
}

/** Result of {@link pingDb}. */
export type DbHealth =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly latencyMs: number; readonly error: string };

/** Default bound on a readiness probe, so a hung server reports unhealthy instead of hanging. */
export const DEFAULT_PING_TIMEOUT_MS = 2_000;

/** Options for {@link createAppDatabase}. */
export interface CreateAppDatabaseOptions {
  /** Environment to read (default `process.env`, through `@blackwing/config`). */
  readonly source?: EnvSource;
  readonly logger?: DbLogger;
  readonly metrics?: DbPoolMetrics;
  readonly applicationName?: string;
}

/** Wraps a pool in Drizzle with the Blackwing schema. */
export function createDatabase(pool: pg.Pool): Database {
  return drizzle({ client: pool, schema });
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : error.name;
  }
  return 'unknown';
}

/**
 * Runs `SELECT 1` on `pool` within `timeoutMs`. Reports `{ ok: false }` (never throws) while the
 * database is unreachable; node-postgres replaces broken connections, so it recovers by itself.
 */
export async function pingPool(
  pool: pg.Pool,
  timeoutMs: number = DEFAULT_PING_TIMEOUT_MS,
): Promise<DbHealth> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('ping timed out'));
    }, timeoutMs);
    timer.unref();
  });
  const query = pool.query('SELECT 1');
  // A late failure after the timeout must not surface as an unhandled rejection.
  query.catch(() => undefined);
  try {
    await Promise.race([query, timeout]);
    return { ok: true, latencyMs: elapsed() };
  } catch (error) {
    return { ok: false, latencyMs: elapsed(), error: errorCode(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** The runtime connection is not a plain RLS subject (§8.6). */
export class UnsafeDbRoleError extends Error {
  readonly code = 'DB_ROLE_UNSAFE' as const;
  constructor(detail: string) {
    super(`refusing the runtime database role: ${detail}`);
    this.name = 'UnsafeDbRoleError';
  }
}

/**
 * Fails closed unless the pool's role is subject to RLS: not a superuser, no `BYPASSRLS`, not the
 * owner role and not a member of it. Call it once at startup, before serving traffic.
 */
export async function verifyAppRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{
    user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    owner_member: boolean;
  }>(
    `SELECT current_user AS user, r.rolsuper, r.rolbypassrls,
            COALESCE(pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = $1), 'MEMBER'), false) AS owner_member
       FROM pg_roles r WHERE r.rolname = current_user`,
    [DB_ROLES.owner],
  );
  const role = rows[0];
  if (role === undefined) throw new UnsafeDbRoleError('current role not found');
  if (role.rolsuper) throw new UnsafeDbRoleError('it is a superuser');
  if (role.rolbypassrls) throw new UnsafeDbRoleError('it has BYPASSRLS');
  if (role.user === DB_ROLES.owner || role.owner_member) {
    throw new UnsafeDbRoleError(`it is or inherits ${DB_ROLES.owner}`);
  }
}

/** Creates a runtime database on the app role from the environment. Throws `CONFIG_INVALID` early. */
export function createAppDatabase(options: CreateAppDatabaseOptions = {}): AppDatabase {
  const config = loadAppDbConfig(options.source);
  const logger = options.logger ?? createLogger('@blackwing/db');
  const pool = createPool(config, 'app', {
    logger,
    guards: config.guards,
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    ...(options.applicationName === undefined ? {} : { applicationName: options.applicationName }),
  });
  let closing: Promise<void> | undefined;
  return {
    db: createDatabase(pool),
    pool,
    ping: (timeoutMs) => pingPool(pool, timeoutMs),
    close: () => {
      closing ??= pool.end().then(() => {
        logger.info({ pool: pool.poolName }, 'db.pool.end');
      });
      return closing;
    },
  };
}

let shared: AppDatabase | undefined;

/** The process-wide runtime database (app role), created on first use from `process.env`. */
export function appDatabase(): AppDatabase {
  shared ??= createAppDatabase();
  return shared;
}

/** The process-wide runtime Drizzle client: the package's default client. */
export function getDb(): Database {
  return appDatabase().db;
}

/** Readiness probe (API-011): `SELECT 1` on the shared app pool. */
export function pingDb(timeoutMs?: number): Promise<DbHealth> {
  return appDatabase().ping(timeoutMs);
}

/** Graceful shutdown: ends the shared app pool if it was created. Idempotent. */
export async function closeDb(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.close();
}
