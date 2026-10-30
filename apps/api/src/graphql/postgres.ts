import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import {
  assetCredentials,
  assetGroupMembers,
  assetGroups,
  assets,
  assetTags,
  assessmentRequests,
  type Database,
  memberships,
  users,
  withTenant,
} from '@blackwing/db';

import type { AssessmentReadStore, AssetReadStore, MemberReadStore } from './store.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

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

const ASSET_UUID = z.uuid();

/** The asset columns the read model selects. `identifiers` and `attestation` are summarised by the caller, never returned as-is. */
const ASSET_COLUMNS = {
  id: assets.id,
  tenantId: assets.tenantId,
  publicId: assets.publicId,
  type: assets.type,
  name: assets.name,
  environment: assets.environment,
  verificationStatus: assets.verificationStatus,
  verificationMethod: assets.verificationMethod,
  verifiedAt: assets.verifiedAt,
  verificationExpiresAt: assets.verificationExpiresAt,
  ownerUserId: assets.ownerUserId,
  attestation: assets.attestation,
  createdAt: assets.createdAt,
  updatedAt: assets.updatedAt,
} as const;

/** The `IN (...)` filter of a batched read over one asset column. */
function assetIdsIn(column: AnyPgColumn, assetIds: readonly string[]): SQL {
  return inArray(column, [...assetIds]);
}

/**
 * The Postgres read store of the asset resolvers (ASSET read model, API-009). Each call runs in `withTenant`, so the
 * RLS policies confine it to the caller's tenant, and the explicit tenant filters repeat that. Soft-deleted assets are
 * never read. Credential roles select the role name, MFA type and secret reference only.
 */
export function createPgAssetReadStore(db: Database): AssetReadStore {
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
    listAssets: (tenantId, query) =>
      withTenant(db, tenantId, (tx) => {
        const createdAt = sql`date_trunc('milliseconds', ${assets.createdAt})`;
        const conditions: SQL[] = [eq(assets.tenantId, tenantId), isNull(assets.deletedAt)];
        const { filter, after } = query;
        if (filter.verificationStatus !== undefined)
          conditions.push(eq(assets.verificationStatus, filter.verificationStatus));
        if (filter.type !== undefined) conditions.push(eq(assets.type, filter.type));
        if (filter.environment !== undefined)
          conditions.push(eq(assets.environment, filter.environment));
        if (filter.tagKey !== undefined) {
          const tagged = and(eq(assetTags.tenantId, tenantId), eq(assetTags.key, filter.tagKey));
          conditions.push(
            inArray(
              assets.id,
              tx
                .select({ id: assetTags.assetId })
                .from(assetTags)
                .where(
                  filter.tagValue === undefined
                    ? tagged
                    : and(tagged, eq(assetTags.value, filter.tagValue)),
                ),
            ),
          );
        }
        if (filter.group !== undefined) {
          conditions.push(
            inArray(
              assets.id,
              tx
                .select({ id: assetGroupMembers.assetId })
                .from(assetGroupMembers)
                .innerJoin(
                  assetGroups,
                  and(
                    eq(assetGroups.tenantId, assetGroupMembers.tenantId),
                    eq(assetGroups.id, assetGroupMembers.groupId),
                  ),
                )
                .where(
                  and(eq(assetGroupMembers.tenantId, tenantId), eq(assetGroups.name, filter.group)),
                ),
            ),
          );
        }
        if (after !== undefined) {
          conditions.push(
            sql`(${createdAt}, ${assets.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`,
          );
        }
        return tx
          .select(ASSET_COLUMNS)
          .from(assets)
          .where(and(...conditions))
          .orderBy(desc(createdAt), desc(assets.id))
          .limit(query.limit);
      }),
    findAsset: async (tenantId, ref) =>
      withTenant(db, tenantId, async (tx) => {
        const match = ASSET_UUID.safeParse(ref).success
          ? eq(assets.id, ref)
          : eq(assets.publicId, ref);
        const rows = await tx
          .select(ASSET_COLUMNS)
          .from(assets)
          .where(and(eq(assets.tenantId, tenantId), isNull(assets.deletedAt), match))
          .limit(1);
        return rows[0];
      }),
    tagsOf: async (tenantId, assetIds) => {
      if (assetIds.length === 0) return new Map();
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ assetId: assetTags.assetId, key: assetTags.key, value: assetTags.value })
          .from(assetTags)
          .where(and(eq(assetTags.tenantId, tenantId), assetIdsIn(assetTags.assetId, assetIds)))
          .orderBy(asc(assetTags.key)),
      );
      return groupBy(
        rows,
        (row) => row.assetId,
        (row) => ({ key: row.key, value: row.value }),
      );
    },
    groupsOf: async (tenantId, assetIds) => {
      if (assetIds.length === 0) return new Map();
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            assetId: assetGroupMembers.assetId,
            id: assetGroups.id,
            name: assetGroups.name,
          })
          .from(assetGroupMembers)
          .innerJoin(
            assetGroups,
            and(
              eq(assetGroups.tenantId, assetGroupMembers.tenantId),
              eq(assetGroups.id, assetGroupMembers.groupId),
            ),
          )
          .where(
            and(
              eq(assetGroupMembers.tenantId, tenantId),
              assetIdsIn(assetGroupMembers.assetId, assetIds),
            ),
          )
          .orderBy(asc(assetGroups.name)),
      );
      return groupBy(
        rows,
        (row) => row.assetId,
        (row) => ({ id: row.id, name: row.name }),
      );
    },
    credentialRolesOf: async (tenantId, assetIds) => {
      if (assetIds.length === 0) return new Map();
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            assetId: assetCredentials.assetId,
            roleName: assetCredentials.roleName,
            mfaType: assetCredentials.mfaType,
            secretRef: assetCredentials.secretRef,
          })
          .from(assetCredentials)
          .where(
            and(
              eq(assetCredentials.tenantId, tenantId),
              assetIdsIn(assetCredentials.assetId, assetIds),
            ),
          )
          .orderBy(asc(assetCredentials.roleName)),
      );
      return groupBy(
        rows,
        (row) => row.assetId,
        (row) => ({
          roleName: row.roleName,
          mfaType: row.mfaType,
          secretRef: row.secretRef,
        }),
      );
    },
  };
}

/** Groups rows by a key, keeping their order. */
function groupBy<R, T>(
  rows: readonly R[],
  key: (row: R) => string,
  value: (row: R) => T,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(key(row)) ?? [];
    group.push(value(row));
    grouped.set(key(row), group);
  }
  return grouped;
}
