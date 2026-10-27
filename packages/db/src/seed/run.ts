// Writes the seed plan (DEVENV-011). Platform-scope rows (tenant, users) go through the owner pool (the tenant row under its own tenant context);
// every tenant-scoped row goes through the app pool inside a transaction with `SET LOCAL app.tenant_id`,
// so RLS applies to each insert (§7, §8.6). Upserts on deterministic keys make re-runs converge.

import { TenantContextMissingError } from '@blackwing/errors';
import { isUuidV7, newId, type Uuid } from '@blackwing/ids';
import { type IsoTimestamp, nowIso } from '@blackwing/time';

import {
  buildTenantSeedPlan,
  type PersonaKey,
  SEED_PERSONAS,
  tenantRow,
  type TenantSeedPlan,
  userRows,
} from './plan.js';
import { assertSeedSchema } from './schema-contract.js';

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
  readonly juiceShopUrl: string;
  /** Keycloak `sub` per persona; personas absent here keep (or get) a `pending:` subject. */
  readonly subjects?: Partial<Record<PersonaKey, string>>;
  /** Delete the seeded tenant rows first (`db:seed:reset`). */
  readonly reset?: boolean;
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

/** Deletes the tenant-scoped rows this seed owns (under the tenant context, so RLS applies). */
async function deleteSeededRows(tx: pg.PoolClient, plan: TenantSeedPlan): Promise<void> {
  const assetId = plan.asset.id;
  await tx.query('DELETE FROM role_matrices WHERE asset_id = $1', [assetId]);
  await tx.query('DELETE FROM asset_credentials WHERE asset_id = $1', [assetId]);
  await tx.query('DELETE FROM standing_authorisations WHERE id = $1', [
    plan.standingAuthorisation.id,
  ]);
  await tx.query('DELETE FROM assets WHERE id = $1', [assetId]);
  await tx.query('DELETE FROM memberships WHERE user_id = ANY($1::uuid[])', [
    plan.memberships.map((m) => m.userId),
  ]);
}

async function upsertTenantRows(tx: pg.PoolClient, plan: TenantSeedPlan): Promise<void> {
  const tenantId = plan.tenantId;
  for (const m of plan.memberships) {
    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, roles, created_at, updated_at)
       VALUES ($1, $2, $3::text[], now(), now())
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, updated_at = now()`,
      [tenantId, m.userId, m.roles],
    );
  }
  const a = plan.asset;
  await tx.query(
    `INSERT INTO assets (id, tenant_id, type, identifiers, environment, owner_user_id,
       verification_status, verification_method, attestation, created_at, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9::jsonb, now(), now())
     ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, identifiers = EXCLUDED.identifiers,
       environment = EXCLUDED.environment, owner_user_id = EXCLUDED.owner_user_id,
       verification_status = EXCLUDED.verification_status,
       verification_method = EXCLUDED.verification_method, attestation = EXCLUDED.attestation,
       updated_at = now()`,
    [
      a.id,
      tenantId,
      a.type,
      a.identifiers,
      a.environment,
      a.ownerUserId,
      a.verificationStatus,
      a.verificationMethod,
      json(a.attestation),
    ],
  );
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
  await tx.query(
    `INSERT INTO standing_authorisations (id, tenant_id, asset_ids, scope_rules, max_intrusiveness,
       pre_approved_test_classes, default_budgets, test_windows, valid_from, expires_at, requester_id,
       approver_id, signature, signing_key_id, status, created_at, updated_at)
     VALUES ($1, $2, $3::uuid[], $4::jsonb, $5, $6::text[], $7::jsonb, $8::jsonb, $9, $10, $11, $12,
       $13, $14, $15, now(), now())
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
  await tx.query(
    `INSERT INTO role_matrices (id, tenant_id, asset_id, name, roles, matrix, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, now(), now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, roles = EXCLUDED.roles,
       matrix = EXCLUDED.matrix, updated_at = now()`,
    [r.id, tenantId, r.assetId, r.name, r.roles, json(r.matrix)],
  );
}

const TENANT_TABLES = [
  'memberships',
  'assets',
  'asset_credentials',
  'standing_authorisations',
  'role_matrices',
] as const;

/** Row count per tenant-scoped table as seen under `tenantId` (RLS applies). */
async function countVisible(
  appPool: pg.Pool,
  tenantId: string,
): Promise<Record<(typeof TENANT_TABLES)[number], number>> {
  return inTenant(appPool, tenantId, async (tx) => {
    const counts = {} as Record<(typeof TENANT_TABLES)[number], number>;
    for (const table of TENANT_TABLES) {
      const { rows } = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
      counts[table] = Number(rows[0]?.n ?? 0);
    }
    return counts;
  });
}

/** Isolation self-check: under a fresh, unrelated tenant id nothing seeded may be visible (§8.6). */
async function assertIsolated(appPool: pg.Pool): Promise<void> {
  const counts = await countVisible(appPool, newId());
  const leaked = Object.entries(counts).filter(([, n]) => n > 0);
  if (leaked.length > 0) {
    throw new Error(
      `db:seed: tenant isolation broken, rows visible to another tenant in ${leaked.map(([t]) => t).join(', ')}`,
    );
  }
}

/**
 * Seeds (or re-seeds) the demo tenant. Fails fast if the schema is missing, validates every row
 * (SoD, secret refs, verified asset, active unexpired SA) before writing, and proves isolation after.
 */
export async function runSeed(options: SeedOptions): Promise<SeedSummary> {
  const now = (options.now ?? (() => nowIso()))();
  await assertSeedSchema(options.ownerPool);
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
    ...(options.requester === undefined ? {} : { requester: options.requester }),
    ...(options.approver === undefined ? {} : { approver: options.approver }),
  });
  await inTenant(options.appPool, tenantId, async (tx) => {
    if (options.reset === true) await deleteSeededRows(tx, plan);
    await upsertTenantRows(tx, plan);
  });
  const visible = await countVisible(options.appPool, tenantId);
  await assertIsolated(options.appPool);
  const counts = { tenants: 1, users: SEED_PERSONAS.length, ...visible };
  options.logger?.info(
    { tenant: 'acme', counts, reset: options.reset === true, asset: 'juice-shop (verified)' },
    'db:seed complete',
  );
  return { tenantId, tenantSlug: 'acme', counts };
}
