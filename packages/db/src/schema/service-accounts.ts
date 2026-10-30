import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  SERVICE_ACCOUNT_DESCRIPTION_MAX,
  SERVICE_ACCOUNT_NAME_MAX,
  SERVICE_ACCOUNT_ROLES,
  SERVICE_ACCOUNT_STATUSES,
} from '@blackwing/contracts';

import {
  idColumn,
  softDelete,
  stateVersion,
  tenantIdColumn,
  tenantIdIndex,
  timestamps,
} from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';
import { memberships, tenants } from './tenancy.js';

/**
 * Service accounts (RBAC-005, CONTEXT_PACK §7, §8.4, §8.6). A tenant-scoped non-human principal that owns
 * API and CI tokens (RBAC-006). The row holds identity and the constrained role set only; it never holds
 * a secret, because a token stores only its hash.
 *
 * The owner is a member of the same tenant: a composite foreign key to `memberships(tenant_id, user_id)`
 * stops a row from pointing at another tenant's user, which a plain FK would allow because FK checks run
 * with RLS bypassed. The role check is generated from the contract's assignable roles, so the database
 * refuses an approval or admin role even if a writer forgets to.
 *
 * Removal is never a hard delete: `DELETE` sets `status = 'disabled'`, so the audit trail and the token
 * history keep their referent. The forward-only migration in `migrations/` is generated from this file
 * (`pnpm db:generate`); FORCE ROW LEVEL SECURITY and the grants are appended by hand (Drizzle does not
 * model them).
 */

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/** Name of the unique index behind `(tenant_id, name)`: one service account name per tenant. */
export const SERVICE_ACCOUNTS_NAME_INDEX = 'service_accounts_tenant_name_idx';

export const serviceAccounts = pgTable(
  'service_accounts',
  {
    id: idColumn(),
    tenantId: tenantIdColumn({ references: () => tenants.id }),
    name: text('name').notNull(),
    description: text('description'),
    /** Subset of the assignable roles (least privilege). Empty means no permission. */
    roles: text('roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ownerUserId: uuid('owner_user_id').notNull(),
    status: text('status', { enum: SERVICE_ACCOUNT_STATUSES }).notNull().default('active'),
    ...timestamps(),
    ...stateVersion(),
    // The repository mixin contract (BaseRepository) requires the column. Removal is a status change
    // (`disabled`), so nothing sets it; it stays NULL.
    ...softDelete(),
  },
  (t) => [
    tenantIdIndex('service_accounts', t.tenantId),
    uniqueIndex(SERVICE_ACCOUNTS_NAME_INDEX).on(t.tenantId, t.name),
    // Target of the tenant-scoped foreign key from the token table (RBAC-006): no cross-tenant reference.
    unique('service_accounts_tenant_id_id_key').on(t.tenantId, t.id),
    index('service_accounts_owner_idx').on(t.tenantId, t.ownerUserId),
    foreignKey({
      name: 'service_accounts_owner_fk',
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    check(
      'service_accounts_name_check',
      sql`length(btrim(${t.name})) BETWEEN 1 AND ${sql.raw(String(SERVICE_ACCOUNT_NAME_MAX))}`,
    ),
    check(
      'service_accounts_description_check',
      sql`${t.description} IS NULL OR length(${t.description}) <= ${sql.raw(String(SERVICE_ACCOUNT_DESCRIPTION_MAX))}`,
    ),
    check(
      'service_accounts_status_check',
      sql`${t.status} IN (${inList(SERVICE_ACCOUNT_STATUSES)})`,
    ),
    check(
      'service_accounts_roles_check',
      sql`${t.roles} <@ ARRAY[${inList(SERVICE_ACCOUNT_ROLES)}]::text[]`,
    ),
    pgPolicy('service_accounts_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type ServiceAccountRow = typeof serviceAccounts.$inferSelect;
export type NewServiceAccountRow = typeof serviceAccounts.$inferInsert;
