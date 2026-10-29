import { Inject, UseInterceptors } from '@nestjs/common';
import { Args, Context, ID, Int, Query, Resolver } from '@nestjs/graphql';
import { z } from 'zod';

import { type EndpointNode, naturalKey } from '@blackwing/contracts';
import { hasPermission } from '@blackwing/domain';
import {
  ForbiddenError,
  NotFoundError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';

import { decodeEndpointCursor, encodeEndpointCursor } from './endpoint-cursor.js';
import {
  EndpointConnectionModel,
  type EndpointEdgeModel,
  type EndpointModel,
  SurfaceSummaryModel,
} from './models.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './page.js';
import { ParamTypes } from './param-types.js';
import { GRAPHQL_METRICS, GRAPHQL_SURFACE_STORE } from './tokens.js';
import { GraphqlTraceInterceptor } from './trace.interceptor.js';
import { tenantContextOf } from '../tenant/guard.js';

import type { GraphqlResolverContext } from './members.resolver.js';
import type { GraphqlMetrics } from './metrics.js';
import type { SurfaceReadStore } from './store.js';
import type { RunSurfaceSummary } from '@blackwing/memory';

const UUID = z.uuid();
const FirstArg = z.int().min(1);

/** Permission that reads runs and their surface (the same grant as the run pages; GRAPH-008 shares this guard). */
const RUN_READ = 'run:read';

/** Converts a run summary to the GraphQL type (ids and counts as the store returns them). */
function toSummaryModel(runId: string, summary: RunSurfaceSummary): SurfaceSummaryModel {
  return {
    runId,
    nodeCounts: summary.nodeCounts.map((entry) => ({ kind: entry.kind, count: entry.count })),
    edgeCounts: summary.edgeCounts.map((entry) => ({ kind: entry.kind, count: entry.count })),
    topTechnologies: summary.topTechnologies.map((entry) => ({
      name: entry.name,
      count: entry.count,
    })),
    endpointCount: summary.endpointCount,
    inScopeEndpointCount: summary.inScopeEndpointCount,
  };
}

/** Converts a contract endpoint node to the GraphQL type. The tenant id is not exposed. */
function toEndpointModel(node: EndpointNode): EndpointModel {
  return {
    method: node.method,
    pathTemplate: node.pathTemplate,
    assetId: node.assetId,
    baseUrl: node.baseUrl ?? null,
    authRequired: node.authRequired,
    contentTypes: [...node.contentTypes],
  };
}

/**
 * Read resolvers of the surface graph for the console dashboard (GRAPH-004, API-009): the summary of one run (counts
 * by kind, top technologies, endpoint totals) and its endpoint inventory as a Relay connection. Both are read-only;
 * the node and edge payload for visualisation stays on REST (GRAPH-008).
 *
 * Authorisation is `run:read` for the caller's roles in the tenant, failing closed. A run that is missing, malformed
 * or owned by another tenant is `not_found`, with the same message in each case, so existence is not leaked. Summaries
 * are batched per request through the surface DataLoader (one graph read per batch, not per tile).
 */
@Resolver(() => SurfaceSummaryModel)
@UseInterceptors(GraphqlTraceInterceptor)
export class SurfaceResolver {
  constructor(
    @Inject(GRAPHQL_SURFACE_STORE) private readonly store: SurfaceReadStore,
    @Inject(GRAPHQL_METRICS) private readonly metrics: GraphqlMetrics,
  ) {}

  /** The surface summary of one run of the caller's tenant. */
  @Query(() => SurfaceSummaryModel, {
    description:
      'Surface summary of one run of the caller tenant (counts, top technologies, endpoints).',
  })
  @ParamTypes(Object, String)
  async surfaceSummary(
    @Context() context: GraphqlResolverContext,
    @Args('runId', { type: () => ID }) runId: string,
  ): Promise<SurfaceSummaryModel> {
    return this.timed('surfaceSummary', async () => {
      const tenantId = await this.readableTenantOf(context);
      const summary = UUID.safeParse(runId).success
        ? await context.loaders.surfaceSummaries.load({ tenantId, id: runId })
        : undefined;
      if (summary === undefined) throw runNotFound();
      return toSummaryModel(runId, summary);
    });
  }

  /** The endpoints of one run of the caller's tenant, newest natural key last, as a page of at most 200. */
  @Query(() => EndpointConnectionModel, {
    description:
      'Endpoints of one run of the caller tenant (Relay connection, at most 200 per page).',
  })
  @ParamTypes(Object, String, Number, String)
  async endpoints(
    @Context() context: GraphqlResolverContext,
    @Args('runId', { type: () => ID }) runId: string,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ): Promise<EndpointConnectionModel> {
    return this.timed('endpoints', async () => {
      const tenantId = await this.readableTenantOf(context);
      const requested = FirstArg.safeParse(first ?? DEFAULT_PAGE_SIZE);
      if (!requested.success) throw new ValidationError('first must be at least 1');
      const size = Math.min(requested.data, MAX_PAGE_SIZE);
      const afterKey = after === undefined ? undefined : decodeEndpointCursor(after);
      const page = UUID.safeParse(runId).success
        ? await this.store.endpointsOf(tenantId, runId, {
            limit: size,
            ...(afterKey === undefined ? {} : { after: afterKey }),
          })
        : undefined;
      if (page === undefined) throw runNotFound();
      const edges = page.nodes.map((node): EndpointEdgeModel => ({
        cursor: encodeEndpointCursor(naturalKey(node)),
        node: toEndpointModel(node),
      }));
      return {
        edges,
        pageInfo: {
          hasNextPage: page.nextCursor !== undefined,
          endCursor: edges.at(-1)?.cursor ?? null,
        },
      };
    });
  }

  /** Runs `work` and records its duration under `graph_gql_resolver_ms{field}`, errors included. */
  private async timed<T>(field: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.metrics.resolverMs.observe({ field }, performance.now() - started);
    }
  }

  /**
   * The caller's tenant, once the caller is shown to hold `run:read` there. Fails closed: no resolved tenant is
   * `tenant_context_missing`; a user id that is not a UUID or has no membership holds no roles, so it is refused.
   */
  private async readableTenantOf(context: GraphqlResolverContext): Promise<string> {
    if (context.req === undefined) {
      throw new TenantContextMissingError('no request on the GraphQL context');
    }
    const resolved = tenantContextOf(context.req);
    if (resolved === undefined)
      throw new TenantContextMissingError('tenant context was not resolved');
    const { tenantId, actor } = resolved;
    const roles = UUID.safeParse(actor.id).success
      ? await this.store.rolesOf(tenantId, actor.id)
      : [];
    if (!hasPermission(roles, RUN_READ)) {
      throw new ForbiddenError('the caller may not read run surfaces', {
        detail: `Missing permission ${RUN_READ} in this tenant.`,
      });
    }
    return tenantId;
  }
}

/** The one answer for a run the caller cannot see, so a foreign run and a missing one look the same. */
function runNotFound(): NotFoundError {
  return new NotFoundError('run not found');
}
