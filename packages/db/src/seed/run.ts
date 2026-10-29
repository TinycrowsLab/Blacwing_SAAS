// Writes the seed plan (DEVENV-011). Platform-scope rows (tenant, users) go through the owner pool (the tenant row under its own tenant context);
// every tenant-scoped row goes through the app pool inside a transaction with `SET LOCAL app.tenant_id`,
// so RLS applies to each insert (§7, §8.6). Upserts on deterministic keys make re-runs converge.

import { TenantContextMissingError } from '@blackwing/errors';
import { isUuidV7, newId, type Uuid } from '@blackwing/ids';
import { type IsoTimestamp, nowIso } from '@blackwing/time';

import { publicId } from '../columns.js';
import {
  buildTenantSeedPlan,
  type PersonaKey,
  SEED_PERSONAS,
  tenantRow,
  type TenantSeedPlan,
  userRows,
} from './plan.js';
import { assertSeedSchema, CORE_SEED_TABLES, findSeedSchemaProblems } from './schema-contract.js';
import { selectSeeders } from './seeders.js';

import type { LabRuleEnv } from '@blackwing/contracts';
import type pg from 'pg';

/**
 * Runs `fn` in a transaction with `SET LOCAL app.tenant_id` (the §7 `withTenant` contract). A missing
 * or malformed tenant id fails closed before any query runs.
 * TODO(#73): replace with the shared `withTenant` helper from packages/db once it lands.
 */
export async function inTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!isUuidV7(tenantId)) {
    throw new TenantContextMissingError('a UUIDv7 tenant id is required: refusing to run');
  }
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw error;
    }
  } finally {
    client.release(broken);
  }
}

/** Minimal logger surface (satisfied by `@blackwing/logger`). */
interface SeedLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface SeedOptions {
  /** Owner-role pool (table owner, e.g. `MIGRATION_DATABASE_URL`): platform-scope rows only. */
  readonly ownerPool: pg.Pool;
  /** App-role pool (`DATABASE_URL`, no BYPASSRLS): every tenant-scoped row. */
  readonly appPool: pg.Pool;
  /** The Juice Shop address the egress gateway targets (the lab service name, #880). */
  readonly juiceShopUrl: string;
  /** `BW_ENV` for the private-range lab gate (`dev` or `test`). */
  readonly labEnv?: LabRuleEnv;
  /** Keycloak `sub` per persona; personas absent here keep (or get) a `pending:` subject. */
  readonly subjects?: Partial<Record<PersonaKey, string>>;
  /** Delete the seeded tenant rows first (`db:seed:reset`). */
  readonly reset?: boolean;
  /** Run only these tenant-scoped steps (`--only`); the platform step always runs. Validated by `parseOnly`. */
  readonly only?: readonly string[];
  readonly now?: () => IsoTimestamp;
  readonly logger?: SeedLogger;
  /** Overrides for tests (e.g. requester == approver must be rejected). */
  readonly requester?: PersonaKey;
  readonly approver?: PersonaKey;
}

export interface SeedSummary {
  readonly tenantId: Uuid;
  readonly tenantSlug: string;
  readonly counts: Readonly<Record<string, number>>;
}

const json = (value: unknown): string => JSON.stringify(value);

async function upsertPlatformRows(
  owner: pg.Pool,
  now: IsoTimestamp,
  subjects: Partial<Record<PersonaKey, string>>,
): Promise<{ tenantId: Uuid; userIds: Record<PersonaKey, Uuid> }> {
  const tenant = tenantRow(now);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    // `tenants` is under FORCE RLS keyed on its own id: the owner too must name the tenant it writes.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
    const t = await client.query<{ id: Uuid }>(
      `INSERT INTO tenants (id, slug, name, status, region, plan, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status,
         region = EXCLUDED.region, plan = EXCLUDED.plan, updated_at = now()
       RETURNING id`,
      [tenant.id, tenant.slug, tenant.name, tenant.status, tenant.region, tenant.plan],
    );
    const userIds: Partial<Record<PersonaKey, Uuid>> = {};
    for (const user of userRows(now, subjects)) {
      const u = await client.query<{ id: Uuid }>(
        `INSERT INTO users (id, keycloak_sub, email, name, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status,
           keycloak_sub = CASE WHEN EXCLUDED.keycloak_sub LIKE 'pending:%'
                               THEN users.keycloak_sub ELSE EXCLUDED.keycloak_sub END,
           updated_at = now()
         RETURNING id`,
        [user.id, user.keycloakSub, user.email, user.name, user.status],
      );
      const id = u.rows[0]?.id;
      if (id !== undefined) userIds[user.persona] = id;
    }
    await client.query('COMMIT');
    const tenantId = t.rows[0]?.id;
    const missing = SEED_PERSONAS.filter((p) => userIds[p.key] === undefined);
    if (tenantId === undefined || missing.length > 0) {
      throw new Error('db:seed: the tenant or user upsert returned no id');
    }
    return { tenantId, userIds: userIds as Record<PersonaKey, Uuid> };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Deletes the tenant-scoped rows this seed owns (under the tenant context, so RLS applies). Only tables that
 * exist are touched: a missing table has no rows to delete.
 */
async function deleteSeededRows(
  tx: pg.PoolClient,
  plan: TenantSeedPlan,
  present: ReadonlySet<string>,
): Promise<void> {
  const assetId = plan.asset.id;
  const del = async (table: string, sql: string, params: unknown[]): Promise<void> => {
    if (present.has(table)) await tx.query(sql, params);
  };
  await del('role_matrices', 'DELETE FROM role_matrices WHERE asset_id = $1', [assetId]);
  await del('asset_credentials', 'DELETE FROM asset_credentials WHERE asset_id = $1', [assetId]);
  await del('standing_authorisations', 'DELETE FROM standing_authorisations WHERE id = $1', [
    plan.standingAuthorisation.id,
  ]);
  await del('assets', 'DELETE FROM assets WHERE id = $1', [assetId]);
  await del('memberships', 'DELETE FROM memberships WHERE user_id = ANY($1::uuid[])', [
    plan.memberships.map((m) => m.userId),
  ]);
}

async function upsertTenantRows(
  tx: pg.PoolClient,
  plan: TenantSeedPlan,
  steps: ReadonlySet<string>,
): Promise<void> {
  const tenantId = plan.tenantId;
  if (steps.has('memberships'))
    for (const m of plan.memberships) {
      await tx.query(
        `INSERT INTO memberships (tenant_id, user_id, roles, created_at, updated_at)
       VALUES ($1, $2, $3::text[], now(), now())
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, updated_at = now()`,
        [tenantId, m.userId, m.roles],
      );
    }
  const a = plan.asset;
  if (steps.has('assets'))
    await tx.query(
      `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id,
       verification_status, verification_method, verified_at, attestation, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10,
       CASE WHEN $9 = 'verified' THEN now() END, $11::jsonb, now(), now())
     ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, name = EXCLUDED.name,
       identifiers = EXCLUDED.identifiers,
       environment = EXCLUDED.environment, owner_user_id = EXCLUDED.owner_user_id,
       verification_status = EXCLUDED.verification_status,
       verification_method = EXCLUDED.verification_method,
       verified_at = EXCLUDED.verified_at, attestation = EXCLUDED.attestation,
       updated_at = now()`,
      [
        a.id,
        tenantId,
        publicId('asset', a.id),
        a.type,
        a.name,
        json(a.identifiers),
        a.environment,
        a.ownerUserId,
        a.verificationStatus,
        a.verificationMethod,
        json(a.attestation),
      ],
    );
  if (steps.has('credentials'))
    for (const c of plan.credentials) {
      await tx.query(
        `INSERT INTO asset_credentials (id, tenant_id, asset_id, role_name, secret_ref, login_recipe,
         mfa_type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now(), now())
       ON CONFLICT (id) DO UPDATE SET role_name = EXCLUDED.role_name, secret_ref = EXCLUDED.secret_ref,
         login_recipe = EXCLUDED.login_recipe, mfa_type = EXCLUDED.mfa_type, updated_at = now()`,
        [c.id, tenantId, c.assetId, c.roleName, c.secretRef, json(c.loginRecipe), c.mfaType],
      );
    }
  const s = plan.standingAuthorisation;
  if (steps.has('standing-authorisations'))
    await tx.query(
      `INSERT INTO standing_authorisations (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness,
       pre_approved_test_classes, default_budgets, test_windows, valid_from, expires_at, requester_id,
       approver_id, signature, signing_key_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4::uuid[], $5::jsonb, $6, $7::text[], $8::jsonb, $9::jsonb, $10, $11, $12, $13,
       $14, $15, $16, now(), now())
     ON CONFLICT (id) DO UPDATE SET asset_ids = EXCLUDED.asset_ids, scope_rules = EXCLUDED.scope_rules,
       max_intrusiveness = EXCLUDED.max_intrusiveness,
       pre_approved_test_classes = EXCLUDED.pre_approved_test_classes,
       default_budgets = EXCLUDED.default_budgets, test_windows = EXCLUDED.test_windows,
       valid_from = EXCLUDED.valid_from, expires_at = EXCLUDED.expires_at,
       requester_id = EXCLUDED.requester_id, approver_id = EXCLUDED.approver_id,
       signature = EXCLUDED.signature, signing_key_id = EXCLUDED.signing_key_id,
       status = EXCLUDED.status, updated_at = now()`,
      [
        s.id,
        tenantId,
        publicId('sa', s.id),
        s.assetIds,
        json(s.scopeRules),
        s.maxIntrusiveness,
        s.preApprovedTestClasses,
        json(s.defaultBudgets),
        json(s.testWindows),
        s.validFrom,
        s.expiresAt,
        s.requesterId,
        s.approverId,
        s.signature,
        s.signingKeyId,
        s.status,
      ],
    );
  const r = plan.roleMatrix;
  if (steps.has('role-matrices'))
    await tx.query(
      `INSERT INTO role_matrices (id, tenant_id, asset_id, version, matrix, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), now())
     ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, matrix = EXCLUDED.matrix,
       active = EXCLUDED.active, updated_at = now()`,
      [r.id, tenantId, r.assetId, r.version, json(r.matrix), r.active],
    );
}

const TENANT_TABLES = [
  'memberships',
  'assets',
  'asset_credentials',
  'standing_authorisations',
  'role_matrices',
] as const;

/** Row count per tenant-scoped table that exists, as seen under `tenantId` (RLS applies). */
async function countVisible(
  appPool: pg.Pool,
  tenantId: string,
  present: ReadonlySet<string>,
): Promise<Record<string, number>> {
  return inTenant(appPool, tenantId, async (tx) => {
    const counts: Record<string, number> = {};
    for (const table of TENANT_TABLES) {
      if (!present.has(table)) continue;
      const { rows } = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
      counts[table] = Number(rows[0]?.n ?? 0);
    }
    return counts;
  });
}

/** Isolation self-check: under a fresh, unrelated tenant id nothing seeded may be visible (§8.6). */
async function assertIsolated(appPool: pg.Pool, present: ReadonlySet<string>): Promise<void> {
  const counts = await countVisible(appPool, newId(), present);
  const leaked = Object.entries(counts).filter(([, n]) => n > 0);
  if (leaked.length > 0) {
    throw new Error(
      `db:seed: tenant isolation broken, rows visible to another tenant in ${leaked.map(([t]) => t).join(', ')}`,
    );
  }
}

/** Rows each tenant-scoped step writes, for the `seed.seeded` log line. */
function rowsPerStep(plan: TenantSeedPlan): Record<string, number> {
  return {
    memberships: plan.memberships.length,
    assets: 1,
    credentials: plan.credentials.length,
    'standing-authorisations': 1,
    'role-matrices': 1,
  };
}

/**
 * Seeds (or re-seeds) the demo tenant. The platform rows come first and fail fast if their tables are missing.
 * Then the tenant-scoped steps run in order, except the ones `--only` leaves out and the ones whose tables are
 * not migrated yet (`seed.skipped`). Validates every row (SoD, secret refs, verified asset, active unexpired SA)
 * before writing, and proves isolation after.
 */
export async function runSeed(options: SeedOptions): Promise<SeedSummary> {
  const now = (options.now ?? (() => nowIso()))();
  const log = options.logger;
  const reset = options.reset === true;
  log?.info({ reset, only: options.only ?? 'all' }, 'seed.start');
  await assertSeedSchema(options.ownerPool, CORE_SEED_TABLES);
  const { tenantId, userIds } = await upsertPlatformRows(
    options.ownerPool,
    now,
    options.subjects ?? {},
  );
  const plan = buildTenantSeedPlan({
    now,
    tenantId,
    userIds,
    juiceShopUrl: options.juiceShopUrl,
    ...(options.labEnv === undefined ? {} : { labEnv: options.labEnv }),
    ...(options.requester === undefined ? {} : { requester: options.requester }),
    ...(options.approver === undefined ? {} : { approver: options.approver }),
  });
  log?.info(
    {
      event: 'scope.private_rule_created',
      tenant: 'acme',
      asset: 'juice-shop',
      privateRules: plan.labScope.privateRuleCount,
      labNetworks: plan.labScope.labNetworks,
      labEnv: options.labEnv ?? 'dev',
    },
    'audit',
  );
  const problems = await findSeedSchemaProblems(options.ownerPool);
  const selection = selectSeeders({ only: options.only, problems });
  const present = new Set(TENANT_TABLES.filter((table) => !problems.has(table)));
  for (const skip of selection.skipped) {
    log?.warn({ seeder: skip.name, reason: skip.reason }, 'seed.skipped');
  }
  const steps = new Set(selection.run);
  // A reset deletes rows the runtime role may not delete (assets and role matrices are soft-deleted or versioned,
  // never removed by bw_app: migration 20261029162611). It runs as the owner under the same tenant context, so
  // FORCE RLS still applies; the upsert then runs as the runtime role as before.
  if (reset)
    await inTenant(options.ownerPool, tenantId, (tx) => deleteSeededRows(tx, plan, present));
  await inTenant(options.appPool, tenantId, (tx) => upsertTenantRows(tx, plan, steps));
  const rows = rowsPerStep(plan);
  for (const name of selection.run) {
    log?.info({ seeder: name, rows: rows[name] ?? 0 }, 'seed.seeded');
  }
  const visible = await countVisible(options.appPool, tenantId, present);
  await assertIsolated(options.appPool, present);
  const counts = { tenants: 1, users: SEED_PERSONAS.length, ...visible };
  log?.info(
    {
      tenant: 'acme',
      counts,
      reset,
      skipped: selection.skipped.map((skip) => skip.name),
      asset: 'juice-shop (verified)',
    },
    'seed.complete',
  );
  return { tenantId, tenantSlug: 'acme', counts };
}

/**
 * The seed for integration and e2e suites: the same run as `pnpm db:seed` (reset allowed, `--only` not), without
 * log lines. The baseline tenant is always `acme`, so its id is deterministic and the summary names it.
 */
export function seedForTest(options: Omit<SeedOptions, 'logger' | 'only'>): Promise<SeedSummary> {
  return runSeed(options);
}
