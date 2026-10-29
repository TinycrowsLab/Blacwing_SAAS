import type { AssetRepository } from '@blackwing/db';

/**
 * The read the asset-list service composes (ASSET-017 scoping input). The Postgres adapter is `AssetRepository`
 * of @blackwing/db, which runs the read in the tenant's `withTenant` transaction. Tests pass an in-memory fake.
 */
export type AssetListStore = Pick<AssetRepository, 'list'>;

/** The roles a user holds in a tenant (RBAC-001). Empty means no permissions. */
export interface AssetListMemberships {
  rolesOf(tenantId: string, userId: string): Promise<readonly string[]>;
}
