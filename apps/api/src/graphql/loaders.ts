import DataLoader from 'dataloader';

import type { MemberReadStore, SurfaceReadStore, UserRow } from './store.js';
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
