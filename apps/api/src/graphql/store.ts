import type { AssessmentRequestStatus, RunMode } from '@blackwing/contracts';

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

/** One assessment request, as the console reads it (SCOPE-001 row, the fields the GraphQL type exposes). */
export interface AssessmentRequestRow {
  readonly id: string;
  readonly publicId: string;
  readonly mode: RunMode;
  readonly status: AssessmentRequestStatus;
  readonly objective: string;
  readonly assetIds: readonly string[];
  readonly saId: string | null;
  readonly inputManifestId: string | null;
  readonly maxIntrusiveness: string;
  readonly requestedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Keyset position of a list: the last row of the previous page (`createdAt` desc, then `id` desc). */
export interface AssessmentRequestPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/** One list read. `viewerId` decides draft visibility; `privileged` sees every draft of the tenant. */
export interface AssessmentRequestQuery {
  readonly status?: AssessmentRequestStatus;
  readonly mode?: RunMode;
  readonly after?: AssessmentRequestPosition;
  /** Rows to read; the adapter reads one more than a page so the caller learns whether a next page exists. */
  readonly limit: number;
  readonly viewerId: string;
  readonly privileged: boolean;
}

/**
 * Read port of the assessment-request GraphQL resolvers (SCOPE-001 / API-009). Like {@link MemberReadStore},
 * every call takes the tenant the guard resolved, and the adapter runs it under that tenant's RLS context.
 */
export interface AssessmentReadStore {
  /** Roles the user holds in `tenantId`; empty when the user has no membership there (fail closed). */
  rolesOf(tenantId: string, userId: string): Promise<readonly string[]>;
  /** Requests of `tenantId` matching `query`, newest first. */
  listRequests(
    tenantId: string,
    query: AssessmentRequestQuery,
  ): Promise<readonly AssessmentRequestRow[]>;
  /** One request of `tenantId` visible to the viewer; absent for another tenant's, a missing or an invisible draft. */
  findRequest(
    tenantId: string,
    id: string,
    viewer: Pick<AssessmentRequestQuery, 'viewerId' | 'privileged'>,
  ): Promise<AssessmentRequestRow | undefined>;
}

/** Roles that may read drafts of other requesters in the tenant (oversight and review). */
export const DRAFT_PRIVILEGED_ROLES: readonly string[] = [
  'appsec_engineer',
  'org_admin',
  'auditor',
];
