import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { Wait } from 'testcontainers';

import { TEST_IMAGES } from './images.js';
import {
  type ContainerOptions,
  containerCredential,
  resolveContainerOptions,
  startContainer,
  type StartedService,
  uniqueSuffix,
  UnsafeTestEnvironmentError,
} from './runtime.js';
import { withTenant } from './tenant.js';

/** The role names from `sql/rls-roles.sql`. */
export const RLS_ROLES = Object.freeze({ owner: 'bw_owner', app: 'bw_app' } as const);

const SQL_DIR = fileURLToPath(new URL('../../sql/', import.meta.url));

/** Absolute paths of the reusable RLS role setup (cluster part, then per-database part). */
export const RLS_SQL_FILES = Object.freeze({
  roles: path.join(SQL_DIR, 'rls-roles.sql'),
  database: path.join(SQL_DIR, 'rls-database.sql'),
});

const POSTGRES_PORT = 5432;
const DEFAULT_APP_POOL_MAX = 5;
const SUPERUSER = 'postgres';
/** Serialises the cluster-wide bootstrap when several test files share a reused container. */
const BOOTSTRAP_LOCK_KEY = 'blackwing-testing:rls-bootstrap';

/** Runs migrations itself, connected as the owner role (e.g. a Drizzle migrator). */
export type MigrationRunner = (
  owner: pg.Client,
  context: { readonly database: string },
) => Promise<void>;

/** Options for {@link withPostgres}. */
export interface WithPostgresOptions extends ContainerOptions {
  /**
   * The schema to load, as the owner role: a directory of `*.sql` files applied in file-name order,
   * each in its own transaction, or a {@link MigrationRunner}.
   */
  readonly migrations?: string | MigrationRunner;
  /** Max connections in the app-role pool (default 5). */
  readonly appPoolMax?: number;
}

/** A migration file failed. */
export class MigrationError extends Error {
  readonly code = 'MIGRATION_FAILED' as const;
  readonly migration: string;

  constructor(migration: string, options: { cause: unknown }) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`migration ${migration} failed: ${detail}`, options);
    this.name = 'MigrationError';
    this.migration = migration;
  }
}

/** A Postgres 16 (+pgvector, pgcrypto) database with the Blackwing RLS role model. */
export interface PostgresHandle {
  readonly service: 'postgres';
  readonly host: string;
  readonly port: number;
  /** A database created for this call only (dropped by `stop`). */
  readonly database: string;
  /** Pool connected as `bw_app`: RLS applies to every query. Use it (through `withTenant`) in tests. */
  readonly appPool: pg.Pool;
  /** Pool connected as `bw_owner` (table owner): for fixtures and catalogue assertions, not for isolation tests. */
  readonly ownerPool: pg.Pool;
  readonly reused: boolean;
  /** Docker id of the container (for debugging and leak checks). */
  readonly containerId: string;
  /** Connection settings for another client library (e.g. Drizzle) as `role`. */
  connectionConfig(role: keyof typeof RLS_ROLES): pg.ClientConfig;
  /** `withTenant(appPool, tenantId, fn)`: a transaction with `SET LOCAL app.tenant_id`. */
  withTenant<T>(tenantId: string, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T>;
  /** Most recent container output. */
  logs(): string;
  /** Closes the pools, drops the database and stops the container (unless reused). Idempotent. */
  stop(): Promise<void>;
}

async function listMigrations(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    throw new MigrationError(dir, { cause: error });
  }
  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new MigrationError(dir, {
      cause: new Error('the migrations directory contains no .sql files'),
    });
  }
  return files.map((file) => path.join(dir, file));
}

async function applyMigrations(
  owner: pg.Client,
  migrations: string | MigrationRunner,
  database: string,
): Promise<void> {
  if (typeof migrations === 'function') {
    await migrations(owner, { database });
    return;
  }
  for (const file of await listMigrations(path.resolve(migrations))) {
    const sql = await readFile(file, 'utf8');
    try {
      await owner.query('BEGIN');
      await owner.query(sql);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK').catch(() => undefined);
      throw new MigrationError(path.basename(file), { cause: error });
    }
  }
}

async function withClient<T>(
  config: pg.ClientConfig,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(config);
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Fails closed if the app role could bypass RLS: isolation tests would otherwise pass vacuously. */
async function assertAppRoleIsRlsSubject(appPool: pg.Pool): Promise<void> {
  const { rows } = await appPool.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    owner_member: boolean;
    user: string;
  }>(
    `SELECT r.rolsuper, r.rolbypassrls, pg_has_role(current_user, $1, 'MEMBER') AS owner_member, current_user AS user
       FROM pg_roles r WHERE r.rolname = current_user`,
    [RLS_ROLES.owner],
  );
  const role = rows[0];
  if (role?.user !== RLS_ROLES.app || role.rolsuper || role.rolbypassrls || role.owner_member) {
    throw new UnsafeTestEnvironmentError(
      `the app role must be ${RLS_ROLES.app} without SUPERUSER, BYPASSRLS or ${RLS_ROLES.owner} membership`,
    );
  }
}

/**
 * Starts Postgres 16 (pgvector image, pinned by digest) and prepares an RLS-ready database:
 *
 * 1. as the superuser: `sql/rls-roles.sql` (roles `bw_owner`, `bw_app` without BYPASSRLS), LOGIN
 *    passwords for both, a fresh database owned by `bw_owner`, then `sql/rls-database.sql`;
 * 2. as `bw_owner`: the given migrations;
 * 3. checks that `bw_app` is a plain RLS subject (fails closed otherwise) and returns pools.
 *
 * Every call gets its own database, so reusing the container (dev opt-in) is safe across test files.
 */
export async function withPostgres(options: WithPostgresOptions = {}): Promise<PostgresHandle> {
  const { image, reuse, startupTimeoutMs } = resolveContainerOptions(options, TEST_IMAGES.postgres);
  const passwords = {
    superuser: containerCredential('postgres:superuser', reuse),
    owner: containerCredential('postgres:bw_owner', reuse),
    app: containerCredential('postgres:bw_app', reuse),
  };
  const started: StartedService = await startContainer({
    service: 'postgres',
    image,
    ports: [POSTGRES_PORT],
    env: {
      POSTGRES_USER: SUPERUSER,
      POSTGRES_PASSWORD: passwords.superuser,
      POSTGRES_DB: 'postgres',
    },
    // Durability is irrelevant for throwaway test data; this makes boot and migrations much faster.
    command: [
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ],
    // The image's init phase starts and stops a temporary server first: wait for the second "ready".
    wait: Wait.forAll([
      Wait.forListeningPorts(),
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    ]),
    reuse,
    startupTimeoutMs,
  });

  const host = started.container.getHost();
  const port = started.container.getMappedPort(POSTGRES_PORT);
  const database = `bw_test_${uniqueSuffix()}`;
  const config = (user: string, password: string, db: string): pg.ClientConfig => ({
    host,
    port,
    user,
    password,
    database: db,
  });
  const superuser = (db: string): pg.ClientConfig => config(SUPERUSER, passwords.superuser, db);

  let appPool: pg.Pool | undefined;
  let ownerPool: pg.Pool | undefined;
  let databaseCreated = false;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all(
      [appPool, ownerPool].map(async (pool) => {
        await pool?.end().catch(() => undefined);
      }),
    );
    try {
      if (databaseCreated) {
        await withClient(superuser('postgres'), (client) =>
          client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
        );
      }
    } finally {
      await started.stop();
    }
  };

  try {
    const [rolesSql, databaseSql] = await Promise.all([
      readFile(RLS_SQL_FILES.roles, 'utf8'),
      readFile(RLS_SQL_FILES.database, 'utf8'),
    ]);
    await withClient(superuser('postgres'), async (client) => {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [BOOTSTRAP_LOCK_KEY]);
      try {
        await client.query(rolesSql);
        for (const [role, password] of [
          [RLS_ROLES.owner, passwords.owner],
          [RLS_ROLES.app, passwords.app],
        ] as const) {
          const { rows } = await client.query<{ sql: string }>(
            "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql",
            [role, password],
          );
          await client.query(rows[0]?.sql ?? 'SELECT 1');
        }
        // `database` is generated above from [0-9a-f] only, so quoting it directly is safe.
        await client.query(`CREATE DATABASE "${database}" OWNER ${RLS_ROLES.owner}`);
        databaseCreated = true;
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [BOOTSTRAP_LOCK_KEY]);
      }
    });
    await withClient(superuser(database), (client) => client.query(databaseSql));
    if (options.migrations !== undefined) {
      const migrations = options.migrations;
      await withClient(config(RLS_ROLES.owner, passwords.owner, database), (owner) =>
        applyMigrations(owner, migrations, database),
      );
    }

    appPool = new pg.Pool({
      ...config(RLS_ROLES.app, passwords.app, database),
      max: options.appPoolMax ?? DEFAULT_APP_POOL_MAX,
    });
    ownerPool = new pg.Pool({ ...config(RLS_ROLES.owner, passwords.owner, database), max: 2 });
    // A container stopping under an idle pool must not crash the test process.
    appPool.on('error', () => undefined);
    ownerPool.on('error', () => undefined);
    await assertAppRoleIsRlsSubject(appPool);
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }

  const app = appPool;
  const owner = ownerPool;
  return {
    service: 'postgres',
    host,
    port,
    database,
    appPool: app,
    ownerPool: owner,
    reused: started.reused,
    containerId: started.containerId,
    connectionConfig: (role) =>
      role === 'app'
        ? config(RLS_ROLES.app, passwords.app, database)
        : config(RLS_ROLES.owner, passwords.owner, database),
    withTenant: (tenantId, fn) => withTenant(app, tenantId, fn),
    logs: () => started.logs(),
    stop,
  };
}
