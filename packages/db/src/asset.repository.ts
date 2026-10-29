// Asset list reads (ASSET-017 scoping input, CONTEXT_PACK §7, §8.6, §8.10). The read runs through `withTenant`,
// so RLS confines it and a missing tenant context fails closed. Soft-deleted assets are never listed. Only the
// fields the scoping wizard renders are selected: identifiers, credentials and attestations stay in the table.

import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from './repository.js';
import { assets } from './schema/assets.js';
import { withTenant } from './with-tenant.js';

import type { Database } from './client.js';
import type {
  AssetEnvironment,
  AssetType,
  ListAssetsQuery,
  VerificationStatus,
} from '@blackwing/contracts';

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

/** One page of the paged list: `nextCursor` is null on the last page. */
export interface AssetListPage {
  readonly items: AssetListRow[];
  readonly nextCursor: string | null;
}

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

  /**
   * One keyset page of live assets, newest first (`created_at desc, id desc`, #355). The projection is the same
   * wizard row as {@link AssetRepository.list}: no identifiers, credentials or attestations. The sort key is
   * truncated to milliseconds, the precision the cursor carries, so concatenated pages equal the unpaged list.
   */
  async page(tenantId: string, query: ListAssetsQuery, limit: number): Promise<AssetListPage> {
    const position = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const createdAt = sql`date_trunc('milliseconds', ${assets.createdAt})`;
    const conditions: (SQL | undefined)[] = [
      eq(assets.tenantId, tenantId),
      isNull(assets.deletedAt),
      query.verificationStatus === undefined
        ? undefined
        : eq(assets.verificationStatus, query.verificationStatus),
      query.type === undefined ? undefined : eq(assets.type, query.type),
      query.environment === undefined ? undefined : eq(assets.environment, query.environment),
    ];
    if (position !== undefined) {
      conditions.push(
        sql`(${createdAt}, ${assets.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
      );
    }
    const rows = await withTenant(this.options.db, tenantId, (tx) =>
      tx
        .select({
          id: assets.id,
          name: assets.name,
          type: assets.type,
          environment: assets.environment,
          verificationStatus: assets.verificationStatus,
          createdAt: assets.createdAt,
        })
        .from(assets)
        .where(and(...conditions))
        .orderBy(desc(createdAt), desc(assets.id))
        .limit(limit + 1),
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        environment: row.environment,
        verificationStatus: row.verificationStatus,
      })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }
}
