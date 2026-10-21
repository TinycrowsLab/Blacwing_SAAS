/**
 * Reusable cross-tenant isolation assertions (TENANT-003, CONTEXT_PACK §8.6, §8.11).
 *
 * Every data-access module imports these and runs them against the real migrations on the
 * Testcontainers Postgres of {@link withPostgres}, connecting as `bw_app` (the role RLS applies to).
 * Running as `bw_owner` or a superuser proves nothing, so the assertions refuse a pool that is not
 * `bw_app`. Each assertion throws {@link TenantIsolationError} (never a vitest matcher), so it works
 * from any test runner and fails loudly when isolation regresses.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { RLS_ROLES } from './postgres.js';
import { type Queryable, withTenant } from './tenant.js';

/** An isolation guarantee does not hold (or the check was set up wrong). */
export class TenantIsolationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TenantIsolationError';
  }
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const TENANT_COLUMN = 'tenant_id';
/** Postgres: undefined_object (`current_setting` without the parameter) and invalid_text_representation (`''::uuid`). */
const MISSING_CONTEXT_CODES = new Set(['42704', '22P02']);
const INSUFFICIENT_PRIVILEGE = '42501';

function ident(table: string): string {
  if (!IDENTIFIER.test(table))
    throw new TenantIsolationError(`"${table}" is not a plain table name`);
  return `"${table}"`;
}

/** The Postgres error code behind a rejected promise, `'none'` if it resolved. */
async function outcome<T>(promise: Promise<T>): Promise<{ value: T } | { code: string }> {
  try {
    return { value: await promise };
  } catch (error) {
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      if (cause instanceof pg.DatabaseError && cause.code !== undefined)
        return { code: cause.code };
    }
    throw error;
  }
}

async function assertAppRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ u: string }>('SELECT current_user AS u');
  if (rows[0]?.u !== RLS_ROLES.app) {
    throw new TenantIsolationError(
      `isolation assertions must run as ${RLS_ROLES.app}, not ${rows[0]?.u ?? 'unknown'}: any other role proves nothing`,
    );
  }
}

/** Every public table that carries a `tenant_id` column (the §8.6 anchor), sorted. */
export async function listTenantTables(ownerPool: pg.Pool): Promise<string[]> {
  const { rows } = await ownerPool.query<{ t: string }>(
    `SELECT c.relname AS t
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = $1 AND NOT a.attisdropped AND a.attnum > 0
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
    [TENANT_COLUMN],
  );
  return rows.map((row) => row.t);
}

/**
 * Meta-test: every tenant table has RLS enabled AND forced and at least one policy. A table added
 * without RLS (or with a disabled policy) fails here. Returns the tables checked.
 */
export async function expectAllTenantTablesForceRls(ownerPool: pg.Pool): Promise<string[]> {
  const tables = await listTenantTables(ownerPool);
  if (tables.length === 0) {
    throw new TenantIsolationError('no tenant table found: the migrations did not run');
  }
  const { rows } = await ownerPool.query<{ t: string; en: boolean; forced: boolean; n: string }>(
    `SELECT c.relname AS t, c.relrowsecurity AS en, c.relforcerowsecurity AS forced,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS n
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = ANY($1)`,
    [tables],
  );
  const bad = rows
    .filter((row) => !row.en || !row.forced || Number(row.n) === 0)
    .map((row) => row.t);
  if (bad.length > 0) {
    throw new TenantIsolationError(
      `tenant tables without enabled + forced RLS and a policy: ${bad.join(', ')}`,
    );
  }
  return tables;
}

/**
 * Meta-test: every tenant table is listed in `covered` (the tables whose isolation tests exist), so a
 * new tenant table fails CI until it gets tests. Returns the tenant tables as the coverage note.
 */
export async function expectEveryTenantTableCovered(
  ownerPool: pg.Pool,
  covered: readonly string[],
): Promise<string[]> {
  const tables = await listTenantTables(ownerPool);
  const missing = tables.filter((table) => !covered.includes(table));
  if (missing.length > 0) {
    throw new TenantIsolationError(
      `tenant tables without cross-tenant tests: ${missing.join(', ')} (add them to the isolation suite)`,
    );
  }
  return tables;
}

/** What {@link expectRlsBlocksCrossTenant} needs. */
export interface CrossTenantOptions {
  readonly tenantA: string;
  readonly tenantB: string;
  /**
   * Inserts one valid row of `table` for `tenantId` inside `tx` (already scoped to a tenant). Used to
   * prove the row is visible to its owner and that a foreign-tenant INSERT is rejected.
   */
  readonly insertRow: (tx: pg.PoolClient, tenantId: string) => Promise<void>;
}

/**
 * Seeds `table` for both tenants, then proves under tenant A's context: A reads its own rows (so an
 * empty result is not a broken query), B's rows are invisible, UPDATE/DELETE of B's rows touch
 * nothing (or are refused), and an INSERT or an UPDATE moving a row to tenant B is rejected by WITH CHECK.
 */
export async function expectRlsBlocksCrossTenant(
  appPool: pg.Pool,
  table: string,
  options: CrossTenantOptions,
): Promise<void> {
  const { tenantA, tenantB, insertRow } = options;
  const t = ident(table);
  await assertAppRole(appPool);
  await withTenant(appPool, tenantA, (tx) => insertRow(tx, tenantA));
  await withTenant(appPool, tenantB, (tx) => insertRow(tx, tenantB));

  const count = (tenant: string, filter: string) =>
    withTenant(appPool, tenant, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${t} WHERE ${filter}`,
        [tenant === tenantA ? tenantB : tenantA],
      );
      return Number(rows[0]?.n);
    });
  const own = await withTenant(appPool, tenantA, async (tx) => {
    const { rows } = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`);
    return Number(rows[0]?.n);
  });
  if (own === 0) {
    throw new TenantIsolationError(
      `${table}: tenant A cannot read its own seeded row (false negative)`,
    );
  }
  for (const tenant of [tenantA, tenantB]) {
    if ((await count(tenant, `${TENANT_COLUMN} = $1`)) !== 0) {
      throw new TenantIsolationError(
        `${table}: a tenant read another tenant's rows (§8.6 violation)`,
      );
    }
  }

  for (const verb of [
    `UPDATE ${t} SET ${TENANT_COLUMN} = ${TENANT_COLUMN} WHERE ${TENANT_COLUMN} = $1`,
    `DELETE FROM ${t} WHERE ${TENANT_COLUMN} = $1`,
  ]) {
    const result = await outcome(withTenant(appPool, tenantA, (tx) => tx.query(verb, [tenantB])));
    if ('value' in result && result.value.rowCount !== 0) {
      throw new TenantIsolationError(
        `${table}: "${verb.split(' ')[0]}" affected another tenant's rows`,
      );
    }
    if ('code' in result && result.code !== INSUFFICIENT_PRIVILEGE) {
      throw new TenantIsolationError(
        `${table}: cross-tenant write failed with ${result.code}, not a denial`,
      );
    }
  }

  const writes: [string, () => Promise<unknown>][] = [
    [
      'INSERT for another tenant',
      () => withTenant(appPool, tenantA, (tx) => insertRow(tx, tenantB)),
    ],
    [
      'UPDATE moving a row to another tenant',
      () =>
        withTenant(appPool, tenantA, (tx) =>
          tx.query(`UPDATE ${t} SET ${TENANT_COLUMN} = $1 WHERE ${TENANT_COLUMN} = $2`, [
            tenantB,
            tenantA,
          ]),
        ),
    ],
  ];
  for (const [label, run] of writes) {
    const result = await outcome(run());
    if ('value' in result) {
      throw new TenantIsolationError(`${table}: ${label} was accepted (WITH CHECK missing)`);
    }
    if (result.code !== INSUFFICIENT_PRIVILEGE) {
      throw new TenantIsolationError(
        `${table}: ${label} failed with ${result.code}, expected a 42501 denial`,
      );
    }
  }
}

/**
 * The canary: with no `app.tenant_id` (never set, or reset to empty) a query on `table` must RAISE.
 * Returning every row, or silently zero rows (a `current_setting('app.tenant_id', true)` regression),
 * fails this check.
 */
export async function expectFailsClosedWithoutContext(
  appPool: pg.Pool,
  table: string,
): Promise<void> {
  const t = ident(table);
  await assertAppRole(appPool);
  // "unset" needs a connection that never ran withTenant: after one, the session keeps the custom
  // setting as '' (not unset), which would mask a current_setting(..., true) regression.
  const PoolClient = appPool.options.Client ?? pg.Client;
  const attempts: [string, () => Promise<pg.Client>][] = [
    ['unset', () => connected(new PoolClient(appPool.options) as pg.Client)],
    ['empty', () => connected(new PoolClient(appPool.options) as pg.Client)],
  ];
  for (const [label, open] of attempts) {
    const client = await open();
    try {
      await client.query('BEGIN');
      if (label === 'empty') await client.query("SELECT set_config('app.tenant_id', '', true)");
      const result = await outcome(client.query(`SELECT count(*) FROM ${t}`));
      await client.query('ROLLBACK');
      if ('value' in result) {
        throw new TenantIsolationError(
          `${table}: a query with ${label} tenant context did not raise (fail-open regression)`,
        );
      }
      if (!MISSING_CONTEXT_CODES.has(result.code)) {
        throw new TenantIsolationError(
          `${table}: ${label} context failed with ${result.code}, expected a missing-context error`,
        );
      }
    } finally {
      await client.end();
    }
  }
}

async function connected(client: pg.Client): Promise<pg.Client> {
  await client.connect();
  return client;
}

/**
 * Reuses ONE pooled connection across `withTenant` calls for different tenants and proves no
 * context bleeds: between transactions the setting is unset, and each transaction sees only its own
 * tenant. Then runs interleaved calls on the whole pool.
 */
export async function expectNoLeakAcrossTransactions(
  appPool: pg.Pool,
  tenantA: string,
  tenantB: string,
): Promise<void> {
  await assertAppRole(appPool);
  const current = async (db: Queryable): Promise<string | null> => {
    const { rows } = await db.query<{ t: string | null }>(
      "SELECT NULLIF(current_setting('app.tenant_id', true), '') AS t",
    );
    return rows[0]?.t ?? null;
  };
  const client = await appPool.connect();
  try {
    for (const tenant of [tenantA, tenantB, tenantA]) {
      const seen = await withTenant(client, tenant, current);
      if (seen !== tenant)
        throw new TenantIsolationError('a transaction did not see its own tenant context');
      if ((await current(client)) !== null) {
        throw new TenantIsolationError(
          'tenant context leaked past the end of a transaction on a reused connection',
        );
      }
    }
  } finally {
    client.release();
  }
  const seen = await Promise.all(
    Array.from({ length: 20 }, (_, i) => {
      const tenant = i % 2 === 0 ? tenantA : tenantB;
      return withTenant(appPool, tenant, async (tx) => {
        await tx.query('SELECT pg_sleep(0.005)');
        return [tenant, await current(tx)] as const;
      });
    }),
  );
  if (seen.some(([want, got]) => want !== got)) {
    throw new TenantIsolationError("interleaved pooled transactions saw another tenant's context");
  }
}

/** `bw_app` must not bypass RLS, be a superuser, change roles, or run DDL. */
export async function expectAppRoleCannotBypass(appPool: pg.Pool): Promise<void> {
  await assertAppRole(appPool);
  const { rows } = await appPool.query<{ bypass: boolean; sup: boolean }>(
    'SELECT rolbypassrls AS bypass, rolsuper AS sup FROM pg_roles WHERE rolname = current_user',
  );
  if (rows[0]?.bypass !== false || rows[0].sup) {
    throw new TenantIsolationError(
      `${RLS_ROLES.app} must have rolbypassrls=false and not be a superuser`,
    );
  }
  const probe = `bw_isolation_probe_${randomUUID().replaceAll('-', '')}`;
  const forbidden: [string, string][] = [
    ['CREATE TABLE', `CREATE TABLE ${probe} (id int)`],
    ['SET ROLE owner', `SET ROLE ${RLS_ROLES.owner}`],
    ['ALTER ROLE', `ALTER ROLE ${RLS_ROLES.app} BYPASSRLS`],
  ];
  for (const [label, statement] of forbidden) {
    const result = await outcome(appPool.query(statement));
    if ('value' in result) {
      await appPool.query(`DROP TABLE IF EXISTS ${probe}`).catch(() => undefined);
      throw new TenantIsolationError(`${RLS_ROLES.app} could run: ${label}`);
    }
    if (result.code !== INSUFFICIENT_PRIVILEGE) {
      throw new TenantIsolationError(
        `${label} failed with ${result.code}, expected insufficient_privilege`,
      );
    }
  }
}
