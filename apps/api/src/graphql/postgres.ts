import { and, asc, desc, eq, inArray, lt, ne, or, type SQL } from 'drizzle-orm';

import { assessmentRequests, type Database, memberships, users, withTenant } from '@blackwing/db';

import type { AssessmentReadStore, MemberReadStore } from './store.js';

/**
 * The Postgres read store behind the GraphQL resolvers (API-009). Every call runs in `withTenant`, so the
 * RLS policy on `memberships` confines it to the caller's tenant. `findUsers` joins through memberships,
 * so a user of another tenant is absent even when its id is known.
 */
export function createPgMemberReadStore(db: Database): MemberReadStore {
  return {
    listMembers: (tenantId, limit) =>
      withTenant(db, tenantId, (tx) =>
        tx
          .select({ userId: memberships.userId, roles: memberships.roles })
          .from(memberships)
          .orderBy(asc(memberships.userId))
          .limit(limit),
      ),
    findUsers: (tenantId, userIds) =>
      withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .innerJoin(memberships, eq(memberships.userId, users.id))
          .where(inArray(users.id, [...userIds]));
        return new Map(rows.map((row) => [row.id, row]));
      }),
  };
}

const REQUEST_COLUMNS = {
  id: assessmentRequests.id,
  publicId: assessmentRequests.publicId,
  mode: assessmentRequests.mode,
  status: assessmentRequests.status,
  objective: assessmentRequests.objective,
  assetIds: assessmentRequests.assetIds,
  saId: assessmentRequests.saId,
  inputManifestId: assessmentRequests.inputManifestId,
  maxIntrusiveness: assessmentRequests.maxIntrusiveness,
  requestedBy: assessmentRequests.requestedBy,
  createdAt: assessmentRequests.createdAt,
  updatedAt: assessmentRequests.updatedAt,
} as const;

/** Visibility of a request to a viewer: non-drafts to every reader; drafts to the requester and privileged roles. */
function visibleTo(viewerId: string, privileged: boolean): SQL | undefined {
  if (privileged) return undefined;
  return or(ne(assessmentRequests.status, 'draft'), eq(assessmentRequests.requestedBy, viewerId));
}

/**
 * The Postgres read store of the assessment-request resolvers (SCOPE-001). Each call runs in `withTenant`, so
 * the RLS policy on `assessment_requests` and the explicit tenant filter both confine it to the caller's tenant.
 */
export function createPgAssessmentReadStore(db: Database): AssessmentReadStore {
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
    listRequests: (tenantId, query) =>
      withTenant(db, tenantId, (tx) => {
        const conditions: SQL[] = [eq(assessmentRequests.tenantId, tenantId)];
        if (query.status !== undefined)
          conditions.push(eq(assessmentRequests.status, query.status));
        if (query.mode !== undefined) conditions.push(eq(assessmentRequests.mode, query.mode));
        const visibility = visibleTo(query.viewerId, query.privileged);
        if (visibility !== undefined) conditions.push(visibility);
        if (query.after !== undefined) {
          const { createdAt, id } = query.after;
          const keyset = or(
            lt(assessmentRequests.createdAt, createdAt),
            and(eq(assessmentRequests.createdAt, createdAt), lt(assessmentRequests.id, id)),
          );
          if (keyset !== undefined) conditions.push(keyset);
        }
        return tx
          .select(REQUEST_COLUMNS)
          .from(assessmentRequests)
          .where(and(...conditions))
          .orderBy(desc(assessmentRequests.createdAt), desc(assessmentRequests.id))
          .limit(query.limit);
      }),
    findRequest: (tenantId, id, viewer) =>
      withTenant(db, tenantId, async (tx) => {
        const visibility = visibleTo(viewer.viewerId, viewer.privileged);
        const rows = await tx
          .select(REQUEST_COLUMNS)
          .from(assessmentRequests)
          .where(
            and(
              eq(assessmentRequests.tenantId, tenantId),
              eq(assessmentRequests.id, id),
              ...(visibility === undefined ? [] : [visibility]),
            ),
          )
          .limit(1);
        return rows[0];
      }),
  };
}
