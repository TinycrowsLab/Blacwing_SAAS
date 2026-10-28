/** One membership of a tenant: which user holds which roles there. */
export interface MemberRow {
  readonly userId: string;
  readonly roles: readonly string[];
}

/** The user fields the console shows. */
export interface UserRow {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
}

/**
 * Read port of the GraphQL resolvers (API-009). Every call takes the tenant id that the tenant guard
 * resolved for the request, and an adapter must run it under that tenant's RLS context, so a row of
 * another tenant is never returned (§8.6).
 */
export interface MemberReadStore {
  /** Memberships of `tenantId`, at most `limit`, ordered by user id. */
  listMembers(tenantId: string, limit: number): Promise<readonly MemberRow[]>;
  /** Users of `tenantId` among `userIds`. A user without a membership in `tenantId` is absent. */
  findUsers(tenantId: string, userIds: readonly string[]): Promise<ReadonlyMap<string, UserRow>>;
}
