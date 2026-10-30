import { Inject, Optional, UseInterceptors } from '@nestjs/common';
import { Args, Context, ID, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { FINDING_DETAIL_INLINE_MAX } from '@blackwing/contracts';
import { AppError, NotFoundError, TenantContextMissingError } from '@blackwing/errors';

import {
  FindingConnectionModel,
  FindingEvidenceModel,
  FindingFilterModel,
  FindingModel,
  FindingOccurrencesModel,
  FindingSeverityModel,
  FindingLocationModel,
} from './findings.models.js';
import { ParamTypes } from './param-types.js';
import { GRAPHQL_FINDINGS } from './tokens.js';
import { GraphqlTraceInterceptor } from './trace.interceptor.js';
import { parseFindingListQuery } from '../findings/query.js';
import { summaryOf, type FindingPrincipal, type FindingService } from '../findings/service.js';
import { tenantContextOf } from '../tenant/guard.js';

import type { GraphqlResolverContext } from './members.resolver.js';
import type { FindingRow } from '@blackwing/db';

/** The GraphQL view of one stored finding: the REST summary, plus the row id that keys its occurrence batch. */
function toModel(row: FindingRow): FindingModel {
  const summary = summaryOf(row);
  return Object.assign(new FindingModel(), {
    id: summary.id,
    title: summary.title,
    class: summary.class,
    status: summary.status,
    baselineStatus: summary.baselineStatus,
    severity:
      summary.severity === null
        ? null
        : Object.assign(new FindingSeverityModel(), {
            cvss4: { ...summary.severity.cvss4 },
          }),
    cweId: summary.cweId,
    owaspCategory: summary.owaspCategory,
    unmapped: summary.unmapped,
    confidence: summary.confidence,
    assetId: summary.assetId,
    location: Object.assign(new FindingLocationModel(), summary.location),
    firstSeenRunId: summary.firstSeenRunId,
    lastSeenRunId: summary.lastSeenRunId,
    stateVersion: summary.stateVersion,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    rowId: row.id,
  });
}

/** The caller, from the tenant the guard resolved for the request. Fails closed when there is none. */
export function principalOf(context: GraphqlResolverContext): FindingPrincipal {
  if (context.req === undefined) {
    throw new TenantContextMissingError('no request on the GraphQL context');
  }
  const resolved = tenantContextOf(context.req);
  if (resolved === undefined)
    throw new TenantContextMissingError('tenant context was not resolved');
  return { tenantId: resolved.tenantId, actorId: resolved.actor.id };
}

/**
 * Read resolvers of the finding query API (FINDING query, API-009): the findings of the caller's tenant as a page with
 * the same filters and cursor as `GET /v1/findings`, and one finding by id. Read-only. Authorisation is the service's
 * (RBAC `finding:read`, then Cedar: Suspected findings are analyst-only, F17). A finding the caller may not see is
 * `null`, so existence does not leak. The nested occurrences and evidence are batched through a DataLoader.
 */
@Resolver(() => FindingModel)
@UseInterceptors(GraphqlTraceInterceptor)
export class FindingsResolver {
  constructor(
    @Optional()
    @Inject(GRAPHQL_FINDINGS)
    private readonly findingService: FindingService | null = null,
  ) {}

  @Query(() => FindingConnectionModel, {
    description: 'Findings of the caller tenant (filters as GET /v1/findings, newest first).',
  })
  @ParamTypes(Object, FindingFilterModel, Number, String)
  async findings(
    @Context() context: GraphqlResolverContext,
    @Args('filter', { type: () => FindingFilterModel, nullable: true }) filter?: FindingFilterModel,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ): Promise<FindingConnectionModel> {
    const service = this.service();
    const principal = principalOf(context);
    const raw: Record<string, unknown> = {
      ...Object.fromEntries(
        Object.entries(filter ?? {}).filter(([, value]) => value !== undefined),
      ),
      ...(first === undefined ? {} : { limit: first }),
      ...(after === undefined ? {} : { cursor: after }),
    };
    const page = await service.page(principal, parseFindingListQuery(raw));
    return {
      items: page.rows.map((row) => toModel(row)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  @Query(() => FindingModel, {
    nullable: true,
    description: 'One finding of the caller tenant, or null when it is missing, foreign or hidden.',
  })
  @ParamTypes(Object, String)
  async finding(
    @Context() context: GraphqlResolverContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FindingModel | null> {
    const service = this.service();
    try {
      return toModel(await service.readable(principalOf(context), id));
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /** The occurrences of the finding, capped per page (default and maximum 50); the rest are counted. */
  @ResolveField(() => FindingOccurrencesModel)
  @ParamTypes(Object, FindingModel, Number)
  async occurrences(
    @Context() context: GraphqlResolverContext,
    @Parent() finding: FindingModel,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
  ): Promise<FindingOccurrencesModel> {
    const rows = await this.occurrencesOf(context, finding);
    const size = Math.min(first ?? FINDING_DETAIL_INLINE_MAX, FINDING_DETAIL_INLINE_MAX);
    const items = rows.slice(0, size).map((o) => ({
      id: o.id,
      runId: o.runId,
      occurrenceStatus: o.occurrenceStatus,
      evidenceChainHead: o.evidenceChainHead,
      detectedAt: o.detectedAt.toISOString(),
    }));
    return { items, total: rows.length, truncated: rows.length > items.length };
  }

  /** The bound evidence refs of the finding, in chain order per occurrence, capped like `occurrences`. */
  @ResolveField(() => FindingEvidenceModel)
  @ParamTypes(Object, FindingModel, Number)
  async evidence(
    @Context() context: GraphqlResolverContext,
    @Parent() finding: FindingModel,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
  ): Promise<FindingEvidenceModel> {
    const refs = (await this.occurrencesOf(context, finding)).flatMap((o) =>
      o.evidenceRefs.map((ref) => ({ ...ref, occurrenceId: o.id, runId: o.runId })),
    );
    const size = Math.min(first ?? FINDING_DETAIL_INLINE_MAX, FINDING_DETAIL_INLINE_MAX);
    const items = refs.slice(0, size);
    return { items, total: refs.length, truncated: refs.length > items.length };
  }

  private async occurrencesOf(context: GraphqlResolverContext, finding: FindingModel) {
    const tenantId = principalOf(context).tenantId;
    return (await context.loaders.findingOccurrences.load({ tenantId, id: finding.rowId })) ?? [];
  }

  private service(): FindingService {
    if (this.findingService === null) {
      throw new AppError('GRAPH_QUERY_UNAVAILABLE', 'findings are not configured');
    }
    return this.findingService;
  }
}
