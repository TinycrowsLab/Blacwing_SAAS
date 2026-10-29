// Asset lookups for the assessment-request submit gate (SCOPE-005, §8.10). Read-only: the asset epic owns writes.
// The lookup runs in the named tenant's `withTenant` transaction, so RLS confines it and another tenant's asset is
// simply absent from the result (a uniform 404 upstream, never an existence leak). A soft-deleted asset is not live
// and is never returned.

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { TenantContextMissingError } from '@blackwing/errors';

import { assets } from './schema/assets.js';
import { withTenant } from './with-tenant.js';

import type { Database } from './client.js';

/** The fields of an asset the submit gate reads: its id, verification state (§8.10) and owner (for the Cedar check). */
export interface AssetCatalogEntry {
  readonly id: string;
  readonly verificationStatus: string;
  readonly ownerUserId: string;
}

export interface AssetCatalogRepositoryOptions {
  readonly db: Database;
}

/** Tenant-scoped asset reads for the submit gate. */
export class AssetCatalogRepository {
  private readonly options: AssetCatalogRepositoryOptions;

  constructor(options: AssetCatalogRepositoryOptions) {
    this.options = options;
  }

  /** The live assets of `tenantId` among `assetIds`. Ids of another tenant, or unknown ones, are absent. */
  async findInTenant(tenantId: string, assetIds: readonly string[]): Promise<AssetCatalogEntry[]> {
    if (tenantId === '')
      throw new TenantContextMissingError('no tenant context: refusing to read assets');
    if (assetIds.length === 0) return [];
    return withTenant(this.options.db, tenantId, (tx) =>
      tx
        .select({
          id: assets.id,
          verificationStatus: assets.verificationStatus,
          ownerUserId: assets.ownerUserId,
        })
        .from(assets)
        .where(
          and(
            eq(assets.tenantId, tenantId),
            inArray(assets.id, [...assetIds]),
            isNull(assets.deletedAt),
          ),
        ),
    );
  }
}
