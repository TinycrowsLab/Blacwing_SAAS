import { z } from 'zod';

import {
  assetListResponseSchema,
  type AssetListResponse,
  type ListAssetsQuery,
} from '@blackwing/contracts';
import { hasPermission } from '@blackwing/domain';
import { ForbiddenError } from '@blackwing/errors';

import type { AssetListMemberships, AssetListStore } from './ports.js';

const uuidSchema = z.uuid();

export interface AssetListPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
}

export interface AssetListServiceDeps {
  readonly store: AssetListStore;
  readonly memberships: AssetListMemberships;
}

/**
 * Lists the tenant's assets for the scoping wizard (ASSET-017). Reading needs `asset:read` in the caller's tenant
 * (RBAC, fail closed: a non-UUID actor id holds no roles). The store is tenant-scoped, so another tenant's assets
 * are never in the answer. Only the wire fields of `assetListItemSchema` are returned.
 */
export class AssetListService {
  private readonly deps: AssetListServiceDeps;

  constructor(deps: AssetListServiceDeps) {
    this.deps = deps;
  }

  async list(principal: AssetListPrincipal, query: ListAssetsQuery): Promise<AssetListResponse> {
    const roles = await this.rolesOf(principal);
    if (!hasPermission(roles, 'asset:read')) {
      throw new ForbiddenError('the caller may not read assets', {
        detail: 'Missing permission asset:read in this tenant.',
      });
    }
    const rows = await this.deps.store.list(principal.tenantId, {
      verificationStatus: query.verificationStatus,
    });
    return assetListResponseSchema.parse({ items: rows });
  }

  private async rolesOf(principal: AssetListPrincipal): Promise<readonly string[]> {
    const userId = uuidSchema.safeParse(principal.actorId);
    return userId.success ? this.deps.memberships.rolesOf(principal.tenantId, userId.data) : [];
  }
}
