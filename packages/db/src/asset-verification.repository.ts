// Asset verification lookup for standing authorisations (AUTHZ-002, CONTEXT_PACK §8.10). Runs through
// `withTenant`, so an asset of another tenant is invisible here and reads as unverified (fail closed). An
// asset is verified only while its status is `verified`, it is live (not soft-deleted) and its verification
// has not expired. Everything else is unverified.

import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import { isActive } from './columns.js';
import { assets } from './schema/assets.js';
import { withTenant } from './with-tenant.js';

import type { Database } from './client.js';

/** Which of `assetIds` are not verified assets of `tenantId`. Unknown and cross-tenant ids count as unverified. */
export async function unverifiedAssetIds(
  db: Database,
  tenantId: string,
  assetIds: readonly string[],
): Promise<readonly string[]> {
  if (assetIds.length === 0) return [];
  const verified = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.tenantId, tenantId),
          inArray(assets.id, [...assetIds]),
          eq(assets.verificationStatus, 'verified'),
          isActive(assets),
          or(isNull(assets.verificationExpiresAt), gt(assets.verificationExpiresAt, sql`now()`)),
        ),
      ),
  );
  const verifiedIds = new Set(verified.map((row) => row.id));
  return assetIds.filter((id) => !verifiedIds.has(id));
}
