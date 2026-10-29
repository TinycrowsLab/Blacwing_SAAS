// The tables and columns `pnpm db:seed` writes (CONTEXT_PACK §7). The seed never creates tables: the
// DB/domain epics own those migrations. Before writing anything the seed checks this contract against the live
// catalogue. The platform tables (CORE_SEED_TABLES) fail fast, naming what is missing. A tenant-scoped step
// whose tables are missing is skipped with `seed.skipped` instead (seeders.ts, #75).

import { PreconditionFailedError } from '@blackwing/errors';

import type pg from 'pg';

/** Acceptable `information_schema.columns.udt_name` values per logical column type. */
const T = {
  uuid: ['uuid'],
  text: ['text', 'varchar', 'citext'],
  textArray: ['_text', '_varchar', '_citext'],
  uuidArray: ['_uuid'],
  json: ['jsonb'],
  timestamp: ['timestamptz'],
  integer: ['int4'],
  boolean: ['bool'],
} as const satisfies Record<string, readonly string[]>;

type ColumnType = keyof typeof T;

const timestamps = { created_at: 'timestamp', updated_at: 'timestamp' } as const;

/** table → column → type. `tenants` and `users` are platform-scope; the rest carry `tenant_id` + RLS. */
const SEED_SCHEMA_CONTRACT = Object.freeze({
  tenants: {
    id: 'uuid',
    slug: 'text',
    name: 'text',
    status: 'text',
    region: 'text',
    plan: 'text',
    ...timestamps,
  },
  users: {
    id: 'uuid',
    keycloak_sub: 'text',
    email: 'text',
    name: 'text',
    status: 'text',
    ...timestamps,
  },
  memberships: { tenant_id: 'uuid', user_id: 'uuid', roles: 'textArray', ...timestamps },
  assets: {
    id: 'uuid',
    tenant_id: 'uuid',
    public_id: 'text',
    type: 'text',
    name: 'text',
    identifiers: 'json',
    environment: 'text',
    owner_user_id: 'uuid',
    verification_status: 'text',
    verification_method: 'text',
    attestation: 'json',
    ...timestamps,
  },
  asset_credentials: {
    id: 'uuid',
    tenant_id: 'uuid',
    asset_id: 'uuid',
    role_name: 'text',
    secret_ref: 'text',
    login_recipe: 'json',
    mfa_type: 'text',
    ...timestamps,
  },
  standing_authorisations: {
    id: 'uuid',
    tenant_id: 'uuid',
    asset_ids: 'uuidArray',
    scope_rules: 'json',
    max_intrusiveness: 'text',
    pre_approved_test_classes: 'textArray',
    default_budgets: 'json',
    test_windows: 'json',
    valid_from: 'timestamp',
    expires_at: 'timestamp',
    requester_id: 'uuid',
    approver_id: 'uuid',
    signature: 'text',
    signing_key_id: 'text',
    status: 'text',
    ...timestamps,
  },
  role_matrices: {
    id: 'uuid',
    tenant_id: 'uuid',
    asset_id: 'uuid',
    version: 'integer',
    matrix: 'json',
    active: 'boolean',
    ...timestamps,
  },
} as const satisfies Record<string, Record<string, ColumnType>>);

/** The schema the seed needs is not there: the migrations have not been applied (or have drifted). */
class SeedPreflightError extends PreconditionFailedError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `db:seed: the database schema is missing what the seed writes (${problems.join('; ')}). ` +
        'Apply the migrations first (`pnpm db:migrate`); the tables come from the DB/domain epics ' +
        '(tenants and users: TENANT-001). The seed never creates tables.',
    );
    this.problems = problems;
  }
}

/** The platform tables (TENANT-001). Without them there is no tenant to seed, so the run fails fast. */
export const CORE_SEED_TABLES: readonly string[] = Object.freeze(['tenants', 'users']);

/**
 * Compares the catalogue with {@link SEED_SCHEMA_CONTRACT}. Returns the problems per table (a missing table
 * or column). A table with no problem is absent from the map.
 */
export async function findSeedSchemaProblems(
  db: pg.Pool | pg.PoolClient,
): Promise<Map<string, string[]>> {
  const tables = Object.keys(SEED_SCHEMA_CONTRACT);
  const { rows } = await db.query<{ table_name: string; column_name: string; udt_name: string }>(
    `SELECT table_name, column_name, udt_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [tables],
  );
  const found = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const columns = found.get(row.table_name) ?? new Map<string, string>();
    columns.set(row.column_name, row.udt_name);
    found.set(row.table_name, columns);
  }
  const problems = new Map<string, string[]>();
  for (const [table, columns] of Object.entries(SEED_SCHEMA_CONTRACT)) {
    const have = found.get(table);
    const tableProblems: string[] = [];
    if (have === undefined) {
      tableProblems.push(`table ${table} does not exist`);
    } else {
      for (const [column, type] of Object.entries<ColumnType>(columns)) {
        const udt = have.get(column);
        if (udt === undefined) tableProblems.push(`column ${table}.${column} does not exist`);
        else if (!(T[type] as readonly string[]).includes(udt))
          tableProblems.push(`column ${table}.${column} is ${udt}, expected ${T[type].join('|')}`);
      }
    }
    if (tableProblems.length > 0) problems.set(table, tableProblems);
  }
  return problems;
}

/** Throws {@link SeedPreflightError} unless every table in `tables` (default: the platform tables) is as the seed expects. */
export async function assertSeedSchema(
  db: pg.Pool | pg.PoolClient,
  tables: readonly string[] = CORE_SEED_TABLES,
): Promise<void> {
  const problems = await findSeedSchemaProblems(db);
  const core = tables.flatMap((table) => problems.get(table) ?? []);
  if (core.length > 0) throw new SeedPreflightError(core);
}
