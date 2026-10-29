import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { ASSET_ENVIRONMENTS, ASSET_IDENTIFIER_KINDS, ASSET_TYPES } from '@blackwing/contracts';
import {
  assets,
  BaseRepository,
  memberships,
  type RepositoryConfig,
  type TenantTx,
} from '@blackwing/db';

/** Longest asset name the table accepts (`LIMITS.labelMax`, mirrored in `assets_name_check`). */
const NAME_MAX = 200;
/** Shortest public id: the `asset_` prefix plus one character. */
const PUBLIC_ID_MIN = 7;

/** What the repository writes. The service has validated the API body; these shapes guard the row. */
const identifierSchema = z.strictObject({
  kind: z.enum(ASSET_IDENTIFIER_KINDS),
  value: z.string().min(1),
});

const insertSchema = z.strictObject({
  id: z.uuid(),
  publicId: z.string().min(PUBLIC_ID_MIN),
  type: z.enum(ASSET_TYPES),
  name: z.string().min(1).max(NAME_MAX),
  identifiers: z.array(identifierSchema).min(1),
  environment: z.enum(ASSET_ENVIRONMENTS),
  ownerUserId: z.uuid(),
  idempotencyKey: z.string().min(1).nullable(),
  idempotencyFingerprint: z.string().min(1).nullable(),
});
export type AssetInsert = z.infer<typeof insertSchema>;

const patchSchema = z.strictObject({
  name: z.string().min(1).max(NAME_MAX).optional(),
  identifiers: z.array(identifierSchema).min(1).optional(),
  environment: z.enum(ASSET_ENVIRONMENTS).optional(),
  ownerUserId: z.uuid().optional(),
});
export type AssetPatch = z.infer<typeof patchSchema>;

/** A stored asset row, as Drizzle returns it. */
export type AssetRow = typeof assets.$inferSelect;

export type AssetRepositoryOptions = Omit<
  RepositoryConfig<typeof assets, AssetInsert, AssetPatch>,
  'entity' | 'table' | 'createSchema' | 'updateSchema'
>;

/**
 * Asset persistence (ASSET-002). Built on `BaseRepository`: `findById` is tenant-scoped and hides soft-deleted
 * rows. Writes take the transaction, so the service commits a row and its audit event together (§8.8). Every
 * query runs under `withTenant`: RLS and the explicit tenant predicate both apply.
 */
export class AssetRepository extends BaseRepository<typeof assets, AssetInsert, AssetPatch> {
  constructor(options: AssetRepositoryOptions) {
    super({
      ...options,
      entity: 'asset',
      table: assets,
      createSchema: insertSchema,
      updateSchema: patchSchema,
    });
  }

  /** Runs `fn` in one tenant transaction. The service uses it so a write and its audit event commit together. */
  transact<R>(op: string, fn: (tx: TenantTx, tenantId: string) => Promise<R>): Promise<R> {
    return this.run(op, async (tx, tenantId) => ({ result: await fn(tx, tenantId), rowCount: 1 }));
  }

  /** One live asset by row id, or undefined (also for another tenant's row). */
  async findLive(tx: TenantTx, id: string): Promise<AssetRow | undefined> {
    const rows = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), isNull(assets.deletedAt)))
      .limit(1);
    return rows[0];
  }

  /** The asset a earlier create with this `Idempotency-Key` produced, in this tenant. */
  async findByIdempotencyKey(tx: TenantTx, key: string): Promise<AssetRow | undefined> {
    const rows = await tx.select().from(assets).where(eq(assets.idempotencyKey, key)).limit(1);
    return rows[0];
  }

  /**
   * Inserts an asset. With an idempotency key the insert is atomic against a concurrent replay: the unique
   * `(tenant_id, idempotency_key)` index decides, and the loser gets `undefined` and re-reads the winner.
   */
  async insert(tx: TenantTx, tenantId: string, values: AssetInsert): Promise<AssetRow | undefined> {
    const row = { ...values, tenantId };
    if (values.idempotencyKey === null) {
      const [created] = await tx.insert(assets).values(row).returning();
      return created;
    }
    const [created] = await tx
      .insert(assets)
      .values(row)
      .onConflictDoNothing({
        target: [assets.tenantId, assets.idempotencyKey],
        where: sql`${assets.idempotencyKey} IS NOT NULL`,
      })
      .returning();
    return created;
  }

  /**
   * Applies `patch` only while the row is at `expectedVersion`, and bumps the version. `undefined` when the row
   * is missing, deleted or changed concurrently; the service maps that to 409 `ASSET_STALE_WRITE`.
   */
  async updateIfVersion(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    patch: AssetPatch,
  ): Promise<AssetRow | undefined> {
    const rows = await tx
      .update(assets)
      .set({
        ...patch,
        stateVersion: sql`${assets.stateVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(assets.id, id), eq(assets.stateVersion, expectedVersion), isNull(assets.deletedAt)),
      )
      .returning();
    return rows[0];
  }

  /** Soft-deletes a live row (`deleted_at`) at `expectedVersion`. Rows are never removed (audit history). */
  async softDeleteIfVersion(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
  ): Promise<AssetRow | undefined> {
    const rows = await tx
      .update(assets)
      .set({
        deletedAt: sql`now()`,
        stateVersion: sql`${assets.stateVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(assets.id, id), eq(assets.stateVersion, expectedVersion), isNull(assets.deletedAt)),
      )
      .returning();
    return rows[0];
  }

  /** The roles of `userId` in this tenant, or `undefined` when not a member. RLS keeps the lookup in-tenant. */
  async rolesOf(tx: TenantTx, userId: string): Promise<readonly string[] | undefined> {
    const rows = await tx
      .select({ roles: memberships.roles })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1);
    return rows[0]?.roles;
  }
}
