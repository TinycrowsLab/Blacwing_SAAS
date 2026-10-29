import { withTenantGraph, type GraphRuntime } from '@blackwing/memory';

import type { SurfaceGraphReader } from './ports.js';

/**
 * The production graph reader: the GRAPH-004 repository under the tenant context of the request (`withTenantGraph`
 * refuses a missing or mismatched tenant before any query). Pass `runtime` in tests; by default the process runtime.
 */
export function createSurfaceGraphReader(runtime?: GraphRuntime): SurfaceGraphReader {
  return {
    readRunSurface: (tenantId, runId, query) =>
      withTenantGraph(tenantId, (repo) => repo.readRunSurface(runId, query), {
        ...(runtime === undefined ? {} : { runtime }),
      }),
  };
}
