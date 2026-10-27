// The tables and columns `pnpm db:seed` writes (CONTEXT_PACK §7). The seed never creates tables: the
// DB/domain epics own those migrations (tenancy #94, assets, SAs, role matrices). Before writing anything
// the seed checks this contract against the live catalogue and fails fast, naming what is missing.

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
    type: 'text',
    identifiers: 'textArray',
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
    name: 'text',
    roles: 'textArray',
    matrix: 'json',
    ...timestamps,
  },
} as const satisfies Record<string, Record<string, ColumnType>>);

/** The schema the seed needs is not there: the migrations have not been applied (or have drifted). */
export class SeedPreflightError extends PreconditionFailedError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `db:seed: the database schema is missing what the seed writes (${problems.join('; ')}). ` +
        'Apply the migrations first (`pnpm db:migrate`); the tables come from the DB/domain epics ' +
        '(tenants/users/memberships: TENANT-001; the rest from later epics). The seed never creates tables.',
    );
    this.problems = problems;
  }
}

/** Compares the catalogue with {@link SEED_SCHEMA_CONTRACT}; returns one line per problem. */
async function findSchemaProblems(db: pg.Pool | pg.PoolClient): Promise<string[]> {
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
  const problems: string[] = [];
  for (const [table, columns] of Object.entries(SEED_SCHEMA_CONTRACT)) {
    const have = found.get(table);
    if (have === undefined) {
      problems.push(`table ${table} does not exist`);
      continue;
    }
    for (const [column, type] of Object.entries<ColumnType>(columns)) {
      const udt = have.get(column);
      if (udt === undefined) problems.push(`column ${table}.${column} does not exist`);
      else if (!(T[type] as readonly string[]).includes(udt))
        problems.push(`column ${table}.${column} is ${udt}, expected ${T[type].join('|')}`);
    }
  }
  return problems;
}

/** Throws {@link SeedPreflightError} unless every table and column the seed writes exists. */
export async function assertSeedSchema(db: pg.Pool | pg.PoolClient): Promise<void> {
  const problems = await findSchemaProblems(db);
  if (problems.length > 0) throw new SeedPreflightError(problems);
}
