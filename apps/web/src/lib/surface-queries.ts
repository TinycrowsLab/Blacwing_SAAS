import { defineQuery } from './graphql-client.js';

/** One count of a kind (a node kind or a relationship type) in a run's surface. */
export interface SurfaceKindCount {
  readonly kind: string;
  readonly count: number;
}

/** The surface summary of one run, as the console dashboard tiles read it (GRAPH-004, API-009). */
export interface SurfaceSummaryData {
  readonly surfaceSummary: {
    readonly runId: string;
    readonly nodeCounts: readonly SurfaceKindCount[];
    readonly edgeCounts: readonly SurfaceKindCount[];
    readonly topTechnologies: readonly { readonly name: string; readonly count: number }[];
    readonly endpointCount: number;
    readonly inScopeEndpointCount: number;
  };
}

/**
 * The run summary the dashboard tiles share. Persisted in production (API-GQL-PERSIST): `pnpm graphql:persist`
 * adds it to the manifest the gate admits.
 */
export const SURFACE_SUMMARY_QUERY = defineQuery<SurfaceSummaryData, { runId: string }>(
  `query SurfaceSummary($runId: ID!) {
    surfaceSummary(runId: $runId) {
      runId
      nodeCounts { kind count }
      edgeCounts { kind count }
      topTechnologies { name count }
      endpointCount
      inScopeEndpointCount
    }
  }`,
);
