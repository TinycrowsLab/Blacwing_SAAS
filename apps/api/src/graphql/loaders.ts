import DataLoader from 'dataloader';

import { currentTenantId } from '@blackwing/db/tenant-context';
import { AppError, TenantContextMissingError } from '@blackwing/errors';

import type {
  AssetGroupRow,
  AssetReadStore,
  AssetTagRow,
  CredentialRoleRow,
  MemberReadStore,
  SurfaceReadStore,
  UserRow,
} from './store.js';
import type { DashboardService } from '../dashboard/service.js';
import type { FindingService } from '../findings/service.js';
import type { FindingOccurrenceRow } from '@blackwing/db';
import type { RunSurfaceSummary } from '@blackwing/memory';

/** A DataLoader key scoped to a tenant. */
export interface TenantKey {
  readonly tenantId: string;
  readonly id: string;
}

/**
 * Generic batch helper (API-009): one call per tick for every key requested in it. A key that fails
 * rejects only its own `load()`; the others still resolve (partial failure).
 */
export function createLoader<K, V, C = K>(
  batch: (keys: readonly K[]) => Promise<readonly (V | Error)[]>,
  cacheKeyFn?: (key: K) => C,
): DataLoader<K, V, C> {
  return new DataLoader<K, V, C>(
    async (keys) => {
      const results = await batch(keys);
      if (results.length !== keys.length)
        throw new Error('loader batch returned a result count that does not match its keys');
      return results;
    },
    cacheKeyFn === undefined ? {} : { cacheKeyFn },
  );
}

/**
 * A loader whose keys carry the tenant (API-009): keys of different tenants are cached apart and batched
 * apart, so a batch for tenant A never runs with tenant B's ids and a result never crosses tenants.
 */
export function createTenantLoader<V>(
  batch: (tenantId: string, ids: readonly string[]) => Promise<readonly (V | undefined)[]>,
): DataLoader<TenantKey, V | undefined, string> {
  return createLoader<TenantKey, V | undefined, string>(
    async (keys) => {
      const byTenant = new Map<string, number[]>();
      keys.forEach((key, index) => {
        const indexes = byTenant.get(key.tenantId) ?? [];
        indexes.push(index);
        byTenant.set(key.tenantId, indexes);
      });
      const results: (V | undefined | Error)[] = keys.map(() => undefined);
      await Promise.all(
        [...byTenant].map(async ([tenantId, indexes]) => {
          const ids = indexes.map((index) => keys[index]?.id ?? '');
          try {
            const values = await batch(tenantId, ids);
            if (values.length !== ids.length) throw new Error('tenant batch result count mismatch');
            indexes.forEach((keyIndex, position) => {
              results[keyIndex] = values[position];
            });
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            for (const keyIndex of indexes) results[keyIndex] = failure;
          }
        }),
      );
      return results;
    },
    (key) => `${key.tenantId}\u0000${key.id}`,
  );
}

/** Loaders built fresh for every GraphQL request (API-009): nothing is cached across requests or tenants. */
export interface RequestLoaders {
  readonly users: DataLoader<TenantKey, UserRow | undefined, string>;
}

export function createRequestLoaders(store: MemberReadStore): RequestLoaders {
  return {
    users: createTenantLoader(async (tenantId, ids) => {
      const rows = await store.findUsers(tenantId, ids);
      return ids.map((id) => rows.get(id));
    }),
  };
}

/** Loaders of the surface resolvers (GRAPH-004): one surface summary per tenant-scoped run id. */
export interface SurfaceLoaders {
  readonly surfaceSummaries: DataLoader<TenantKey, RunSurfaceSummary | undefined, string>;
}

/**
 * Batches the surface summaries of one request (API-009). Every tile of a dashboard that asks for a run's summary in
 * the same tick shares one graph read. A run the tenant does not own loads as `undefined`. `observeBatch` receives the
 * number of keys in each batch (the `graphql_dataloader_batch_size` histogram).
 */
export function createSurfaceLoaders(
  store: SurfaceReadStore,
  observeBatch: (size: number) => void = () => undefined,
): SurfaceLoaders {
  return {
    surfaceSummaries: createTenantLoader(async (tenantId, ids) => {
      observeBatch(ids.length);
      const summaries = await store.summariesOf(tenantId, ids);
      return ids.map((id) => summaries.get(id));
    }),
  };
}

/** Loaders of the finding resolvers: the occurrences of one visible finding, batched per tenant. */
export interface FindingLoaders {
  readonly findingOccurrences: DataLoader<
    TenantKey,
    readonly FindingOccurrenceRow[] | undefined,
    string
  >;
}

/**
 * Batches the occurrences of the findings a request shows (the `occurrences` and `evidence` fields of every finding in
 * one tick share one read). Only findings the caller may read reach it: the root fields authorise them first. A batch
 * runs only inside the tenant it was keyed by (fail closed); `null` service means findings are not configured.
 */
export function createFindingLoaders(findings: FindingService | null): FindingLoaders {
  return {
    findingOccurrences: createTenantLoader(async (tenantId, ids) => {
      if (findings === null) {
        throw new AppError('GRAPH_QUERY_UNAVAILABLE', 'findings are not configured');
      }
      if (currentTenantId() !== tenantId) {
        throw new TenantContextMissingError('finding batch outside its tenant context');
      }
      const byFinding = new Map<string, FindingOccurrenceRow[]>();
      for (const row of await findings.occurrencesOf(ids)) {
        const group = byFinding.get(row.findingId) ?? [];
        group.push(row);
        byFinding.set(row.findingId, group);
      }
      return ids.map((id) => byFinding.get(id) ?? []);
    }),
  };
}

/** Loaders of the dashboard resolvers: the display names of the assets a summary groups by, batched per tenant. */
export interface DashboardLoaders {
  readonly dashboardAssetNames: DataLoader<TenantKey, string | undefined, string>;
}

/**
 * Batches the asset names of one request's dashboard summaries (one read per tick, however many groups ask). A batch
 * runs under the tenant it was keyed by, and `null` service means dashboards are not configured (fail closed).
 */
export function createDashboardLoaders(dashboard: DashboardService | null): DashboardLoaders {
  return {
    dashboardAssetNames: createTenantLoader(async (tenantId, ids) => {
      if (dashboard === null) {
        throw new AppError('GRAPH_QUERY_UNAVAILABLE', 'dashboards are not configured');
      }
      const names = await dashboard.assetNamesOf(tenantId, ids);
      return ids.map((id) => names.get(id));
    }),
  };
}

/**
 * Loaders of the asset resolvers (ASSET read model): the tags, groups and credential roles of one asset, batched per
 * tenant. One asset list page and its nested fields share one read per relation (no N+1). An asset with none of the
 * relation loads as an empty list.
 */
export interface AssetLoaders {
  readonly assetTags: DataLoader<TenantKey, readonly AssetTagRow[] | undefined, string>;
  readonly assetGroups: DataLoader<TenantKey, readonly AssetGroupRow[] | undefined, string>;
  readonly assetCredentialRoles: DataLoader<
    TenantKey,
    readonly CredentialRoleRow[] | undefined,
    string
  >;
}

export function createAssetLoaders(
  store: AssetReadStore | null,
  observeBatch: (size: number) => void = () => undefined,
): AssetLoaders {
  /** The store of a batch; `null` means assets are not configured, so the batch refuses (fail closed). */
  const storeOf = (): AssetReadStore => {
    if (store === null) throw new AppError('GRAPH_QUERY_UNAVAILABLE', 'assets are not configured');
    return store;
  };
  return {
    assetTags: createTenantLoader(async (tenantId, ids) => {
      observeBatch(ids.length);
      const byAsset = await storeOf().tagsOf(tenantId, ids);
      return ids.map((id) => byAsset.get(id) ?? []);
    }),
    assetGroups: createTenantLoader(async (tenantId, ids) => {
      observeBatch(ids.length);
      const byAsset = await storeOf().groupsOf(tenantId, ids);
      return ids.map((id) => byAsset.get(id) ?? []);
    }),
    assetCredentialRoles: createTenantLoader(async (tenantId, ids) => {
      observeBatch(ids.length);
      const byAsset = await storeOf().credentialRolesOf(tenantId, ids);
      return ids.map((id) => byAsset.get(id) ?? []);
    }),
  };
}
