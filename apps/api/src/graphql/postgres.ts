import { asc, eq, inArray } from 'drizzle-orm';

import { type Database, memberships, users, withTenant } from '@blackwing/db';

import type { MemberReadStore } from './store.js';

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
