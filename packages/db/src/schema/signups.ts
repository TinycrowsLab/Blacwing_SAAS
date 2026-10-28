import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

import { SIGNUP_STATUSES } from '@blackwing/contracts';

import { idColumn, timestamps } from '../columns.js';
import { citext } from './columns.js';

/**
 * Pending self-service signups (TENANT-004, CONTEXT_PACK §7). A row exists from the moment an address asks
 * for an account until its token is used, expires or is cancelled; the tenant, owner user and membership
 * are created only when the token is verified.
 *
 * The table is deliberately NOT a tenant table: there is no tenant yet, so there is no `tenant_id` and no
 * RLS (like `users`). The runtime role gets DML and nobody else gets anything. Only the SHA-256 of the
 * token is stored, never the token (§8.7), and `email`/`org_name` are PII that must not reach a log.
 */

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

export const signups = pgTable(
  'signups',
  {
    id: idColumn(),
    /** `citext`: the same address in another case is the same person. */
    email: citext('email').notNull(),
    orgName: text('org_name').notNull(),
    /** The slug base derived from `org_name` at request time; collisions are resolved when the tenant is created. */
    desiredSlug: text('desired_slug'),
    /** Lower-case hex SHA-256 of the 256-bit token. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status', { enum: SIGNUP_STATUSES }).notNull().default('pending'),
    ...timestamps(),
  },
  (t) => [
    // Also the lookup index of the verify endpoint.
    unique('signups_token_hash_key').on(t.tokenHash),
    // The per-address request throttle counts recent rows of one address.
    index('signups_email_created_at_idx').on(t.email, t.createdAt),
    check('signups_status_check', sql`${t.status} IN (${inList(SIGNUP_STATUSES)})`),
    check('signups_token_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type SignupRow = typeof signups.$inferSelect;
export type NewSignupRow = typeof signups.$inferInsert;
