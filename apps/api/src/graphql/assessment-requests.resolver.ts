import { Inject, UseInterceptors } from '@nestjs/common';
import { Args, Context, ID, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';

import { assessmentRequestStatusSchema, runModeSchema } from '@blackwing/contracts';
import { hasPermission } from '@blackwing/domain';
import { ForbiddenError, TenantContextMissingError, ValidationError } from '@blackwing/errors';

import {
  AssessmentRequestConnectionModel,
  type AssessmentRequestEdgeModel,
  AssessmentRequestModel,
  AssetRefModel,
  SARefModel,
type  PageInfoModel } from './models.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './page.js';
import { ParamTypes } from './param-types.js';
import { decodeRequestCursor, encodeRequestCursor } from './request-cursor.js';
import {
  DRAFT_PRIVILEGED_ROLES,
  type AssessmentReadStore,
  type AssessmentRequestRow,
} from './store.js';
import { GRAPHQL_ASSESSMENT_STORE } from './tokens.js';
import { GraphqlTraceInterceptor } from './trace.interceptor.js';
import { tenantContextOf } from '../tenant/guard.js';

import type { GraphqlResolverContext } from './members.resolver.js';

const UUID = z.uuid();

/** Who is asking, in which tenant, and whether they may see every draft of it. */
interface Viewer {
  readonly tenantId: string;
  readonly viewerId: string;
  readonly privileged: boolean;
}

/** Converts a store row to the GraphQL type (dates as ISO-8601 UTC). */
function toModel(row: AssessmentRequestRow): AssessmentRequestModel {
  return {
    id: row.id,
    publicId: row.publicId,
    mode: row.mode,
    status: row.status,
    objective: row.objective,
    assetIds: [...row.assetIds],
    saId: row.saId,
    inputManifestId: row.inputManifestId,
    maxIntrusiveness: row.maxIntrusiveness,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Read resolvers for the console (SCOPE-001, API-009): the assessment requests of the caller's tenant as a
 * Relay connection, and one request by id. Read-only: mutations stay on REST (SCOPE-005). Authorisation is the
 * `assessment:read` permission of the caller's roles in the tenant (fail closed); a draft is visible to its
 * requester and to the {@link DRAFT_PRIVILEGED_ROLES}. A foreign, missing or invisible id answers `null`, so
 * existence is not leaked.
 */
@Resolver(() => AssessmentRequestModel)
@UseInterceptors(GraphqlTraceInterceptor)
export class AssessmentRequestsResolver {
  constructor(@Inject(GRAPHQL_ASSESSMENT_STORE) private readonly store: AssessmentReadStore) {}

  /** Requests of the caller tenant, newest first. `first` is clamped to the platform maximum. */
  @Query(() => AssessmentRequestConnectionModel, {
    description: 'Assessment requests of the caller tenant (Relay connection, newest first).',
  })
  @ParamTypes(Object, String, String, Number, String)
  async assessmentRequests(
    @Context() context: GraphqlResolverContext,
    @Args('status', { type: () => String, nullable: true }) status?: string,
    @Args('mode', { type: () => String, nullable: true }) mode?: string,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ): Promise<AssessmentRequestConnectionModel> {
    const viewer = await this.viewerOf(context);
    const size = Math.min(first ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    if (!Number.isInteger(size) || size < 1) throw new ValidationError('first must be at least 1');
    const parsedStatus =
      status === undefined ? undefined : assessmentRequestStatusSchema.safeParse(status);
    const parsedMode = mode === undefined ? undefined : runModeSchema.safeParse(mode);
    if (parsedStatus?.success === false || parsedMode?.success === false) {
      throw new ValidationError('invalid status or mode filter');
    }
    const rows = await this.store.listRequests(viewer.tenantId, {
      ...(parsedStatus?.success === true ? { status: parsedStatus.data } : {}),
      ...(parsedMode?.success === true ? { mode: parsedMode.data } : {}),
      ...(after === undefined ? {} : { after: decodeRequestCursor(after) }),
      limit: size + 1,
      viewerId: viewer.viewerId,
      privileged: viewer.privileged,
    });
    const page = rows.slice(0, size);
    const edges = page.map((row): AssessmentRequestEdgeModel => ({
      cursor: encodeRequestCursor(row),
      node: toModel(row),
    }));
    const last = edges.at(-1);
    return {
      edges,
      pageInfo: {
        hasNextPage: rows.length > size,
        endCursor: last?.cursor ?? null,
      } satisfies PageInfoModel,
    };
  }

  /** One request by id, or `null` when it is missing, foreign or a draft the caller may not see. */
  @Query(() => AssessmentRequestModel, {
    nullable: true,
    description: 'One assessment request of the caller tenant, or null.',
  })
  @ParamTypes(Object, String)
  async assessmentRequest(
    @Context() context: GraphqlResolverContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AssessmentRequestModel | null> {
    const viewer = await this.viewerOf(context);
    if (!UUID.safeParse(id).success) return null;
    const row = await this.store.findRequest(viewer.tenantId, id, viewer);
    return row === undefined ? null : toModel(row);
  }

  /** The assets under test, as references (their records are not read here). */
  @ResolveField(() => [AssetRefModel])
  assets(@Parent() request: AssessmentRequestModel): AssetRefModel[] {
    return request.assetIds.map((id) => ({ id }));
  }

  /** The standing authorisation, as a reference; `null` while the request is a draft without one. */
  @ResolveField(() => SARefModel, { nullable: true })
  standingAuthorisation(@Parent() request: AssessmentRequestModel): SARefModel | null {
    return request.saId === null ? null : { id: request.saId };
  }

  /**
   * The caller's tenant, user and permission. Fails closed: no resolved tenant is `tenant_context_missing`; a user
   * id that is not a UUID or has no membership holds no roles, so it is refused.
   */
  private async viewerOf(context: GraphqlResolverContext): Promise<Viewer> {
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
    if (!hasPermission(roles, 'assessment:read')) {
      throw new ForbiddenError('the caller may not read assessment requests', {
        detail: 'Missing permission assessment:read in this tenant.',
      });
    }
    return {
      tenantId,
      viewerId: actor.id,
      privileged: roles.some((role) => DRAFT_PRIVILEGED_ROLES.includes(role)),
    };
  }
}
