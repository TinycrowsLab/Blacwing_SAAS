import { Inject, UseInterceptors } from '@nestjs/common';
import { Args, Context, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';

import { TenantContextMissingError, ValidationError } from '@blackwing/errors';

import { TenantMemberModel, UserModel } from './models.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './page.js';
import { ParamTypes } from './param-types.js';
import { GRAPHQL_MEMBER_STORE } from './tokens.js';
import { GraphqlTraceInterceptor } from './trace.interceptor.js';
import { tenantContextOf } from '../tenant/guard.js';

import type { AssetLoaders, FindingLoaders, RequestLoaders, SurfaceLoaders } from './loaders.js';
import type { MemberReadStore } from './store.js';
import type { FastifyRequest } from 'fastify';

const FirstArg = z.number().int().min(1).max(MAX_PAGE_SIZE);

/** The GraphQL context the resolvers read (see `module.ts`). */
export interface GraphqlResolverContext {
  readonly req?: FastifyRequest;
  readonly loaders: RequestLoaders & SurfaceLoaders & FindingLoaders & AssetLoaders;
}

/**
 * The tenant the request was resolved to by the entry point's guard (TENANT-003). Field resolvers read it
 * from the request, not from the async scope: `@nestjs/graphql` runs global interceptors for the operation,
 * not for each nested field. Fail closed when the request carries no tenant.
 */
function tenantIdOf(context: GraphqlResolverContext): string {
  if (context.req === undefined)
    throw new TenantContextMissingError('no request on the GraphQL context');
  const resolved = tenantContextOf(context.req);
  if (resolved === undefined)
    throw new TenantContextMissingError('tenant context was not resolved');
  return resolved.tenantId;
}

/**
 * Read resolvers for the console (API-009): memberships of the caller's tenant, and each member's user through
 * a per-request DataLoader. Mutations are not defined: writes go through REST. Nested fields run the
 * interceptors of this class (the module enables them for field resolvers, see `module.ts`).
 */
@Resolver(() => TenantMemberModel)
@UseInterceptors(GraphqlTraceInterceptor)
export class MembersResolver {
  constructor(@Inject(GRAPHQL_MEMBER_STORE) private readonly store: MemberReadStore) {}

  /** Memberships of the caller's tenant. */
  @Query(() => [TenantMemberModel], { description: 'Memberships of the caller tenant.' })
  @ParamTypes(Object, Number)
  async tenantMembers(
    @Context() context: GraphqlResolverContext,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
  ): Promise<TenantMemberModel[]> {
    const parsed = FirstArg.safeParse(first ?? DEFAULT_PAGE_SIZE);
    if (!parsed.success)
      throw new ValidationError(`first must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    const rows = await this.store.listMembers(tenantIdOf(context), parsed.data);
    return rows.map((row) => ({ userId: row.userId, roles: [...row.roles] }));
  }

  /** The user of a membership, batched with the other members of the same response. */
  @ResolveField(() => UserModel, { nullable: true })
  async user(
    @Parent() member: TenantMemberModel,
    @Context() context: GraphqlResolverContext,
  ): Promise<UserModel | null> {
    const row = await context.loaders.users.load({
      tenantId: tenantIdOf(context),
      id: member.userId,
    });
    return row === undefined ? null : { id: row.id, name: row.name, email: row.email };
  }
}
