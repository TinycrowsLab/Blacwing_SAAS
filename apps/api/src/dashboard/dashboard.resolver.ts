import { Inject, Optional, UseInterceptors } from '@nestjs/common';
import { Args, Context, ID, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { AppError } from '@blackwing/errors';

import {
  CoverageSummaryModel,
  DashboardAssetCountModel,
  DashboardFindingConnectionModel,
  DashboardFindingFilterModel,
  DashboardTrendBucket,
  FindingSummaryModel,
  FindingTrendModel,
} from './models.js';
import { principalOf } from '../graphql/findings.resolver.js';
import { ParamTypes } from '../graphql/param-types.js';
import { GRAPHQL_DASHBOARD } from '../graphql/tokens.js';
import { GraphqlTraceInterceptor } from '../graphql/trace.interceptor.js';

import type {
  DashboardCoverage,
  DashboardFindingPage,
  DashboardService,
  DashboardSummary,
  DashboardTrend,
} from './service.js';
import type { GraphqlResolverContext } from '../graphql/members.resolver.js';

/** The filter as the client sent it, without the fields it left out (GraphQL passes them as null or undefined). */
function filterInput(filter: DashboardFindingFilterModel | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filter ?? {}).filter(([, value]) => value !== undefined && value !== null),
  );
}

/**
 * Read resolvers of the dashboards (DASH-001): the aggregates the console renders, so no page runs SQL or sums rows in
 * the browser. Read-only; every read is authorised and tenant-scoped by the service. Every value is validated there.
 */
@Resolver()
@UseInterceptors(GraphqlTraceInterceptor)
export class DashboardResolver {
  constructor(
    @Optional()
    @Inject(GRAPHQL_DASHBOARD)
    private readonly dashboard: DashboardService | null = null,
  ) {}

  @Query(() => FindingSummaryModel, {
    description:
      'Counts of the caller tenant findings per severity, OWASP, CWE, asset, status and baseline state.',
  })
  @ParamTypes(Object, DashboardFindingFilterModel)
  async findingSummary(
    @Context() context: GraphqlResolverContext,
    @Args('filter', { type: () => DashboardFindingFilterModel, nullable: true })
    filter?: DashboardFindingFilterModel,
  ): Promise<DashboardSummary> {
    return this.service().summary(principalOf(context), filterInput(filter));
  }

  @Query(() => FindingTrendModel, {
    description: 'Distinct findings of one asset per UTC day or ISO week, per baseline state.',
  })
  @ParamTypes(Object, String, DashboardTrendBucket)
  async findingTrend(
    @Context() context: GraphqlResolverContext,
    @Args('assetId', { type: () => ID }) assetId: string,
    @Args('bucket', { type: () => DashboardTrendBucket }) bucket: DashboardTrendBucket,
  ): Promise<DashboardTrend> {
    return this.service().trend(principalOf(context), assetId, bucket);
  }

  @Query(() => CoverageSummaryModel, {
    description: 'Coverage of one run, or of the newest run of one asset (give exactly one).',
  })
  @ParamTypes(Object, String, String)
  async coverageSummary(
    @Context() context: GraphqlResolverContext,
    @Args('runId', { type: () => ID, nullable: true }) runId?: string,
    @Args('assetId', { type: () => ID, nullable: true }) assetId?: string,
  ): Promise<DashboardCoverage> {
    return this.service().coverage(principalOf(context), { runId, assetId });
  }

  @Query(() => DashboardFindingConnectionModel, {
    description:
      'A page of the caller tenant findings matching the filter (newest first, at most 200).',
  })
  @ParamTypes(Object, DashboardFindingFilterModel, String, Number)
  async findingsConnection(
    @Context() context: GraphqlResolverContext,
    @Args('filter', { type: () => DashboardFindingFilterModel, nullable: true })
    filter?: DashboardFindingFilterModel,
    @Args('cursor', { type: () => String, nullable: true }) cursor?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<DashboardFindingPage> {
    return this.service().connection(principalOf(context), {
      filter: filterInput(filter),
      cursor: cursor ?? undefined,
      limit: limit ?? undefined,
    });
  }

  private service(): DashboardService {
    if (this.dashboard === null) {
      throw new AppError('GRAPH_QUERY_UNAVAILABLE', 'dashboards are not configured');
    }
    return this.dashboard;
  }
}

/** The asset name on a summary's asset group: one DataLoader batch per tenant and request, never one read per group. */
@Resolver(() => DashboardAssetCountModel)
@UseInterceptors(GraphqlTraceInterceptor)
export class DashboardAssetCountResolver {
  @ResolveField(() => String, {
    nullable: true,
    description: 'Display name of the asset, when it is live and in the caller tenant.',
  })
  @ParamTypes(Object, DashboardAssetCountModel)
  async assetName(
    @Context() context: GraphqlResolverContext,
    @Parent() group: DashboardAssetCountModel,
  ): Promise<string | null> {
    const { tenantId } = principalOf(context);
    const name = await context.loaders.dashboardAssetNames.load({ tenantId, id: group.assetId });
    return name ?? null;
  }
}
