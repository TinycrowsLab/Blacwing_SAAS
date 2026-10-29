import { and, eq, inArray } from 'drizzle-orm';

import { type Database, memberships, runs, withTenant } from '@blackwing/db';
import { withTenantGraph } from '@blackwing/memory';

import type { SurfaceReadStore } from './store.js';

/**
 * The read store behind the surface resolvers (GRAPH-004 read model). A run is the tenant's only when its row is
 * visible under the tenant's RLS context (`runs`); only those runs are read from the graph, which pins every query to
 * the tenant as well. So a foreign or missing run is absent here, and its graph data is never touched.
 */
export function createSurfaceReadStore(db: Database): SurfaceReadStore {
  /** The subset of `runIds` that are runs of the tenant. */
  const ownedRunIds = (tenantId: string, runIds: readonly string[]): Promise<string[]> =>
    withTenant(db, tenantId, async (tx) => {
      const rows = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.tenantId, tenantId), inArray(runs.id, [...runIds])));
      return rows.map((row) => row.id);
    });

  return {
    rolesOf: (tenantId, userId) =>
      withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ roles: memberships.roles })
          .from(memberships)
          .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
          .limit(1);
        return rows[0]?.roles ?? [];
      }),
    summariesOf: async (tenantId, runIds) => {
      if (runIds.length === 0) return new Map();
      const owned = await ownedRunIds(tenantId, runIds);
      if (owned.length === 0) return new Map();
      return withTenantGraph(tenantId, (repository) => repository.summariseRuns(owned));
    },
    endpointsOf: async (tenantId, runId, page) => {
      const [owned] = await ownedRunIds(tenantId, [runId]);
      if (owned === undefined) return undefined;
      return withTenantGraph(tenantId, (repository) => repository.listRunEndpoints(runId, page));
    },
  };
}
