import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { LIMITS } from '@blackwing/contracts';

import { idColumn } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';

/**
 * Tenant Cedar policy versions (POLICY-001, CONTEXT_PACK §7, §8.6, §8.11). Each row is one immutable
 * version of a tenant's policy text. Only `active` may change after insert: the pointer moves when a
 * version is activated or rolled back, and history is never deleted. A tenant has at most one active
 * version; a tenant with none evaluates the platform baseline only (fail toward the floor). The
 * forward-only migration in `migrations/` is generated from this file (`pnpm db:generate`) and then
 * reviewed; FORCE ROW LEVEL SECURITY, the column-level grant and the immutability trigger are appended
 * by hand because Drizzle does not model them.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const tenantPolicies = pgTable(
  'policies',
  {
    id: idColumn(),
    tenantId: uuid('tenant_id').notNull(),
    /** Monotonic per tenant, starting at 1. */
    version: integer('version').notNull(),
    /** The tenant policy text (canonical form, see `@blackwing/policy`). */
    cedarSource: text('cedar_source').notNull(),
    /** Present when the version was authored through the rule builder (POLICY-004). */
    ruleBuilderJson: jsonb('rule_builder_json').$type<Record<string, unknown>>(),
    /** SHA-256 (hex) over the canonical `cedar_source`. */
    sha256: text('sha256').notNull(),
    /** The user who created the version: a user reference only. */
    author: uuid('author').notNull(),
    active: boolean('active').notNull().default(false),
    note: text('note'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('policies_tenant_version_key').on(t.tenantId, t.version),
    // The single active pointer: at most one version per tenant is active.
    uniqueIndex('policies_one_active_idx')
      .on(t.tenantId)
      .where(sql`${t.active}`),
    check('policies_version_check', sql`${t.version} >= 1`),
    check(
      'policies_source_size_check',
      sql`octet_length(${t.cedarSource}) <= ${sql.raw(String(LIMITS.policySourceMaxBytes))}`,
    ),
    check('policies_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'policies_rule_builder_json_check',
      sql`${t.ruleBuilderJson} IS NULL OR jsonb_typeof(${t.ruleBuilderJson}) = 'object'`,
    ),
    check(
      'policies_note_check',
      sql`${t.note} IS NULL OR length(${t.note}) <= ${sql.raw(String(LIMITS.policyNoteMax))}`,
    ),
    pgPolicy('policies_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type TenantPolicyRow = typeof tenantPolicies.$inferSelect;
export type NewTenantPolicyRow = typeof tenantPolicies.$inferInsert;
