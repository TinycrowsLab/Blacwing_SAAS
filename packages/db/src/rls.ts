// The RLS helper (DB-003, CONTEXT_PACK §7, §8.6): the single deterministic enforcement point for
// tenant isolation. Every tenant table routes its policy through `rlsPolicySql`; no module writes
// its own. The predicate has no `missing_ok` argument, so a request without `app.tenant_id` raises
// instead of matching nothing-or-everything: the database fails closed.
//
// Violations surface as Postgres errors; `toTenantIsolationError` maps them to AppErrors:
//   - missing / malformed app.tenant_id (42704, 22P02)    -> TenantContextMissingError
//   - WITH CHECK violation on INSERT/UPDATE (42501)       -> ForbiddenError
//   - cross-tenant UPDATE / DELETE: USING hides the row   -> 0 rows affected, no error
// Error messages never include row data or the other tenant's id.

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

import { ForbiddenError, TenantContextMissingError } from '@blackwing/errors';

/** The runtime role that receives DML on every tenant table (DB-001). */
export const APP_ROLE = 'bw_app';

/** The column every tenant table must carry (§8.6 anchor). */
export const TENANT_COLUMN = 'tenant_id';

/** Postgres truncates identifiers at 63 bytes; the policy name is `<table>_tenant_isolation`. */
const POLICY_SUFFIX = '_tenant_isolation';
const MAX_IDENTIFIER = 63;

/** Statement separator drizzle-kit uses inside generated migration files. */
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** The table cannot be given the tenant policy (bad name, or no `tenant_id` column). */
export class RlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RlsConfigError';
  }
}

export interface RlsPolicyOptions {
  /** Column names of the table. When given, a missing `tenant_id` fails generation. */
  readonly columns?: readonly string[];
}

/** Name of the one tenant policy of `table`. */
export function rlsPolicyName(table: string): string {
  return `${table}${POLICY_SUFFIX}`;
}

/** The canonical predicate, shared by USING and WITH CHECK. Never use `current_setting(..., true)`. */
export const RLS_PREDICATE = `${TENANT_COLUMN} = current_setting('app.tenant_id')::uuid`;

function resolveTable(
  table: string | PgTable,
  options: RlsPolicyOptions,
): { name: string; columns?: readonly string[] } {
  if (typeof table === 'string') {
    return options.columns ? { name: table, columns: options.columns } : { name: table };
  }
  const config = getTableConfig(table);
  return { name: config.name, columns: config.columns.map((column) => column.name) };
}

/**
 * SQL that enables and forces RLS on a tenant table, installs the canonical tenant policy for ALL
 * commands (USING + WITH CHECK) and grants `SELECT, INSERT, UPDATE, DELETE` to `bw_app` only
 * (never PUBLIC, never TRUNCATE). Pass a table name (optionally with `columns`) or a drizzle table.
 *
 * Throws {@link RlsConfigError} for an unsafe name or a table without `tenant_id`, so a bad
 * migration fails at generation time rather than shipping an unprotected table.
 */
export function rlsPolicySql(table: string | PgTable, options: RlsPolicyOptions = {}): string {
  const { name, columns } = resolveTable(table, options);
  if (!IDENTIFIER.test(name)) {
    throw new RlsConfigError(
      'table name must be a plain lower-case identifier (letters, digits, underscore)',
    );
  }
  if (name.length + POLICY_SUFFIX.length > MAX_IDENTIFIER) {
    throw new RlsConfigError(
      `table name "${name}" is too long: its policy name would exceed ${MAX_IDENTIFIER} characters`,
    );
  }
  if (columns && !columns.includes(TENANT_COLUMN)) {
    throw new RlsConfigError(
      `table "${name}" has no ${TENANT_COLUMN} column: it cannot be a tenant table`,
    );
  }
  const t = `"${name}"`;
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "${rlsPolicyName(name)}" ON ${t} AS PERMISSIVE FOR ALL USING (${RLS_PREDICATE}) WITH CHECK (${RLS_PREDICATE});`,
    `REVOKE ALL ON ${t} FROM PUBLIC;`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${APP_ROLE};`,
  ].join('\n');
}

/** Migration macro: the policy SQL for several tables, split with drizzle's statement breakpoints. */
export function rlsMigrationSql(tables: readonly (string | PgTable)[]): string {
  return tables
    .flatMap((table) => rlsPolicySql(table).split('\n'))
    .join(`${STATEMENT_BREAKPOINT}\n`);
}

/** Anything with a pg-style `query` (a Pool, a PoolClient). */
export interface RlsQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface RlsState {
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly policies: readonly { name: string; command: string; using: string; withCheck: string }[];
}

/** Reads RLS flags and policies of a table in the current schema from the catalogue. */
export async function readRlsState(db: RlsQueryable, table: string): Promise<RlsState> {
  const flags = await db.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = to_regclass(quote_ident($1))`,
    [table],
  );
  const row = flags.rows[0];
  if (!row) throw new RlsConfigError(`table "${table}" does not exist`);
  const policies = await db.query(
    `SELECT policyname, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = $1 ORDER BY policyname`,
    [table],
  );
  return {
    enabled: row.relrowsecurity === true,
    forced: row.relforcerowsecurity === true,
    policies: policies.rows.map((p) => ({
      name: String(p.policyname),
      command: String(p.cmd),
      using: String(p.qual),
      withCheck: String(p.with_check),
    })),
  };
}

const normalise = (sqlText: string): string => sqlText.replace(/[\s()]/g, '').toLowerCase();

/**
 * Test util: asserts `table` has RLS enabled and forced and exactly one policy, the canonical
 * tenant policy for ALL commands with the fail-closed predicate in both USING and WITH CHECK.
 */
export async function assertRlsEnabled(db: RlsQueryable, table: string): Promise<void> {
  const state = await readRlsState(db, table);
  if (!state.enabled) throw new RlsConfigError(`RLS is not enabled on "${table}"`);
  if (!state.forced) throw new RlsConfigError(`RLS is not forced on "${table}"`);
  if (state.policies.length !== 1) {
    throw new RlsConfigError(
      `expected exactly one policy on "${table}", found ${state.policies.length}`,
    );
  }
  const [policy] = state.policies;
  if (policy?.name !== rlsPolicyName(table) || policy.command !== 'ALL') {
    throw new RlsConfigError(
      `"${table}" does not have the canonical tenant policy for ALL commands`,
    );
  }
  const expected = normalise(`${TENANT_COLUMN} = (current_setting('app.tenant_id'::text))::uuid`);
  if (normalise(policy.using) !== expected || normalise(policy.withCheck) !== expected) {
    throw new RlsConfigError(`"${table}" policy predicate is not the canonical tenant predicate`);
  }
}

/** Maps a Postgres error from a tenant-scoped query to an AppError, or `undefined` if unrelated. */
export function toTenantIsolationError(error: unknown): Error | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  const message = (error as { message?: unknown } | null)?.message;
  const text = typeof message === 'string' ? message : '';
  if (code === '42704' && text.includes('app.tenant_id')) {
    return new TenantContextMissingError('tenant context is not set', {
      reason: 'missing',
      cause: error,
    });
  }
  if (code === '22P02' && text.includes('uuid')) {
    return new TenantContextMissingError('tenant context is not a valid tenant id', {
      reason: 'invalid_uuid',
      cause: error,
    });
  }
  if (code === '42501' && text.includes('row-level security')) {
    return new ForbiddenError('row violates tenant isolation', { cause: error });
  }
  return undefined;
}
