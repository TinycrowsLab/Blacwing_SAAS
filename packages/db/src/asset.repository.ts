// Asset list reads (ASSET-017 scoping input, CONTEXT_PACK §7, §8.6, §8.10). The read runs through `withTenant`,
// so RLS confines it and a missing tenant context fails closed. Soft-deleted assets are never listed. Only the
// fields the scoping wizard renders are selected: identifiers, credentials and attestations stay in the table.

import { and, asc, eq, isNull } from 'drizzle-orm';

import { assets } from './schema/assets.js';
import { withTenant } from './with-tenant.js';

import type { Database } from './client.js';
import type { AssetEnvironment, AssetType, VerificationStatus } from '@blackwing/contracts';

/** One asset row as the list reads it. `id` is the asset's UUID, the id a request names in `assetIds`. */
export interface AssetListRow {
  readonly id: string;
  readonly name: string;
  readonly type: AssetType;
  readonly environment: AssetEnvironment;
  readonly verificationStatus: VerificationStatus;
}

export interface AssetRepositoryOptions {
  readonly db: Database;
}

/** Upper bound of one list read. The scoping wizard lists verified assets, and a tenant never needs more here. */
const LIST_LIMIT = 500;

/** Tenant-scoped reads of the asset inventory. Writes belong to the ASSET module, not to this class. */
export class AssetRepository {
  private readonly options: AssetRepositoryOptions;

  constructor(options: AssetRepositoryOptions) {
    this.options = options;
  }

  /** Live assets of `tenantId`, optionally filtered by verification state, ordered by name then id. */
  async list(
    tenantId: string,
    filter: { readonly verificationStatus?: VerificationStatus | undefined } = {},
  ): Promise<AssetListRow[]> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: assets.id,
          name: assets.name,
          type: assets.type,
          environment: assets.environment,
          verificationStatus: assets.verificationStatus,
        })
        .from(assets)
        .where(
          and(
            eq(assets.tenantId, tenantId),
            isNull(assets.deletedAt),
            filter.verificationStatus === undefined
              ? undefined
              : eq(assets.verificationStatus, filter.verificationStatus),
          ),
        )
        .orderBy(asc(assets.name), asc(assets.id))
        .limit(LIST_LIMIT);
      return rows;
    });
  }
}
