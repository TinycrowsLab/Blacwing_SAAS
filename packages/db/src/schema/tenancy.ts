import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { TENANT_STATUSES, USER_STATUSES } from '@blackwing/contracts';

import { idColumn, publicId, tenantIdColumn, timestamps } from '../columns.js';
import { citext, TENANT_PREDICATE } from './columns.js';

import type { PublicId } from '@blackwing/ids';

/**
 * The tenancy tables (TENANT-001, CONTEXT_PACK §7, §8.6): `tenants`, `users`, `memberships`. The
 * forward-only migration in `migrations/` is generated from this file (`pnpm db:generate`); the
 * `memberships` RLS block in it is the output of `rlsPolicySql('memberships')` (DB-003) and the
 * `tenants` block is its `id`-keyed twin ({@link TENANTS_SELF_PREDICATE}), both with FORCE ROW LEVEL
 * SECURITY, which drizzle does not model. No policy is written by hand anywhere else.
 */

/**
 * The `tenants` policy predicate: the tenant row itself is the tenant key. Identical to DB-003's
 * `RLS_PREDICATE` with `id` for `tenant_id`, so it fails closed the same way (no `missing_ok`).
 */
export const TENANTS_SELF_PREDICATE: SQL = sql`id = current_setting('app.tenant_id')::uuid`;

const SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

export const tenants = pgTable(
  'tenants',
  {
    id: idColumn(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: TENANT_STATUSES }).notNull().default('active'),
    region: text('region').notNull(),
    plan: text('plan').notNull().default('free'),
    ...timestamps(),
  },
  (t) => [
    // The unique constraint is also the `tenants(slug)` lookup index; likewise `users(email)`.
    unique('tenants_slug_key').on(t.slug),
    check('tenants_status_check', sql`${t.status} IN (${inList(TENANT_STATUSES)})`),
    check(
      'tenants_slug_check',
      sql`${t.slug} ~ ${sql.raw(`'${SLUG_PATTERN}'`)} AND length(${t.slug}) BETWEEN 3 AND 63`,
    ),
    pgPolicy('tenants_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANTS_SELF_PREDICATE,
      withCheck: TENANTS_SELF_PREDICATE,
    }),
  ],
);

/** Global (non-tenant) identities: no `tenant_id`, no RLS; access to tenant data comes from memberships. */
export const users = pgTable(
  'users',
  {
    id: idColumn(),
    /** The OIDC subject at Keycloak. Opaque, not a secret. */
    keycloakSub: text('keycloak_sub').notNull(),
    /** `citext`: case-insensitive, one account per address. Never logged (§5 redaction). */
    email: citext('email').notNull(),
    name: text('name'),
    status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    unique('users_keycloak_sub_key').on(t.keycloakSub),
    unique('users_email_key').on(t.email),
    check('users_status_check', sql`${t.status} IN (${inList(USER_STATUSES)})`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    tenantId: tenantIdColumn({ references: () => tenants.id }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Empty means no permissions (RBAC enforces); the values are `Role`s from @blackwing/contracts. */
    roles: text('roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ name: 'memberships_pkey', columns: [t.tenantId, t.userId] }),
    index('memberships_user_id_idx').on(t.userId),
    pgPolicy('memberships_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type TenantRow = typeof tenants.$inferSelect;
export type NewTenantRow = typeof tenants.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type MembershipRow = typeof memberships.$inferSelect;
export type NewMembershipRow = typeof memberships.$inferInsert;

/** The public id (`ten_<base32>`) of a tenant row id (§5). */
export function tenantPublicId(tenantId: string): PublicId<'ten'> {
  return publicId('ten', tenantId);
}

/** The public id (`usr_<base32>`) of a user row id (§5). */
export function userPublicId(userId: string): PublicId<'usr'> {
  return publicId('usr', userId);
}
