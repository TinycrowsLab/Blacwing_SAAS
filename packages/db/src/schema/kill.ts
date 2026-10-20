import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  KILL_EVENT_STATUSES,
  KILL_SCOPES,
  KILL_SCOPES_WITH_REF,
  KILL_SOURCES,
  type KillAffected,
  SOC_CONTACT_STATUSES,
  SOC_KILL_TOKEN_SCOPES,
} from '@blackwing/contracts';

import { timestamps } from '../columns.js';
import { bytea, citext, TENANT_PREDICATE } from './columns.js';

/**
 * Kill-switch persistence (KILL-001, F33, CONTEXT_PACK §7, §8.5, §8.6). Schema only: propagation,
 * the API and re-enable belong to later KILL issues. The forward-only migrations in `migrations/`
 * are generated from this file (`pnpm db:generate`) and then reviewed; FORCE ROW LEVEL SECURITY and
 * the operator grants are appended by hand because Drizzle does not model them.
 */

/**
 * The platform-operator role (created NOLOGIN by `@blackwing/testing/sql/rls-roles.sql`, the shared
 * cluster bootstrap). It is the only path that can write or read `global` kill events, whose
 * `tenant_id` is null.
 */
export const operatorRole = pgRole('bw_operator').existing();

/** The runtime role every request uses; subject to RLS (no BYPASSRLS, §7). */
export const appRole = pgRole('bw_app').existing();

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

export const killEvents = pgTable(
  'kill_events',
  {
    id: uuid('id').primaryKey(),
    /** Null only for `global` platform-operator events (operator path only; never visible to tenants). */
    tenantId: uuid('tenant_id'),
    scope: text('scope', { enum: KILL_SCOPES }).notNull(),
    scopeRefId: uuid('scope_ref_id'),
    source: text('source', { enum: KILL_SOURCES }).notNull(),
    actorType: text('actor_type').notNull(),
    actorRef: text('actor_ref').notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: KILL_EVENT_STATUSES }).notNull().default('initiated'),
    triggeredAt: ts('triggered_at').notNull().defaultNow(),
    egressBlockedAt: ts('egress_blocked_at'),
    sandboxesTerminatedAt: ts('sandboxes_terminated_at'),
    keysRevokedAt: ts('keys_revoked_at'),
    workflowsCancelledAt: ts('workflows_cancelled_at'),
    completedAt: ts('completed_at'),
    haltMs: integer('halt_ms'),
    affected: jsonb('affected').$type<KillAffected>().notNull().default({}),
    reenabledAt: ts('reenabled_at'),
    reenabledBy: uuid('reenabled_by'),
    ...timestamps(),
  },
  (t) => [
    index('kill_events_tenant_scope_ref_idx').on(t.tenantId, t.scope, t.scopeRefId),
    index('kill_events_tenant_triggered_at_idx').on(t.tenantId, t.triggeredAt.desc()),
    check('kill_events_scope_check', sql`${t.scope} IN (${inList(KILL_SCOPES)})`),
    check('kill_events_source_check', sql`${t.source} IN (${inList(KILL_SOURCES)})`),
    check('kill_events_status_check', sql`${t.status} IN (${inList(KILL_EVENT_STATUSES)})`),
    check(
      'kill_events_scope_ref_check',
      sql`(${t.scope} IN (${inList(KILL_SCOPES_WITH_REF)})) = (${t.scopeRefId} IS NOT NULL)`,
    ),
    check('kill_events_tenant_check', sql`${t.tenantId} IS NOT NULL OR ${t.scope} = 'global'`),
    check('kill_events_reason_check', sql`length(btrim(${t.reason})) > 0`),
    check('kill_events_halt_ms_check', sql`${t.haltMs} IS NULL OR ${t.haltMs} >= 0`),
    check('kill_events_affected_check', sql`jsonb_typeof(${t.affected}) = 'object'`),
    check(
      'kill_events_reenabled_check',
      sql`(${t.reenabledAt} IS NULL) = (${t.reenabledBy} IS NULL)`,
    ),
    // Granted to the app role only (not PUBLIC) so the operator role sees just its own policy and
    // never evaluates the tenant predicate, which errors without a tenant context.
    pgPolicy('kill_events_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appRole,
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
    pgPolicy('kill_events_operator_global', {
      as: 'permissive',
      for: 'all',
      to: operatorRole,
      using: sql`tenant_id IS NULL AND scope = 'global'`,
      withCheck: sql`tenant_id IS NULL AND scope = 'global'`,
    }),
  ],
);

export const socContacts = pgTable(
  'soc_contacts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    /** Null: the contact covers every asset of the tenant. */
    assetId: uuid('asset_id'),
    name: text('name').notNull(),
    email: citext('email').notNull(),
    phone: text('phone'),
    notifyPrewindow: boolean('notify_prewindow').notNull().default(true),
    notifyStart: boolean('notify_start').notNull().default(true),
    notifyEnd: boolean('notify_end').notNull().default(true),
    locale: text('locale').notNull().default('en'),
    status: text('status', { enum: SOC_CONTACT_STATUSES }).notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    index('soc_contacts_tenant_asset_idx').on(t.tenantId, t.assetId),
    // Target of the tenant-scoped foreign key from soc_kill_tokens (no cross-tenant references).
    unique('soc_contacts_tenant_id_id_key').on(t.tenantId, t.id),
    check('soc_contacts_status_check', sql`${t.status} IN (${inList(SOC_CONTACT_STATUSES)})`),
    pgPolicy('soc_contacts_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export const socKillTokens = pgTable(
  'soc_kill_tokens',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    scope: text('scope', { enum: SOC_KILL_TOKEN_SCOPES }).notNull(),
    scopeRefId: uuid('scope_ref_id'),
    /** SHA-256 of the raw token; the raw token is never stored. Unique: a collision is rejected. */
    tokenSha256: bytea('token_sha256').notNull(),
    contactId: uuid('contact_id'),
    expiresAt: ts('expires_at').notNull(),
    maxUses: integer('max_uses').notNull().default(1),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    unique('soc_kill_tokens_token_sha256_key').on(t.tokenSha256),
    index('soc_kill_tokens_tenant_scope_ref_idx').on(t.tenantId, t.scope, t.scopeRefId),
    index('soc_kill_tokens_tenant_contact_idx').on(t.tenantId, t.contactId),
    foreignKey({
      name: 'soc_kill_tokens_contact_fk',
      columns: [t.tenantId, t.contactId],
      foreignColumns: [socContacts.tenantId, socContacts.id],
    }),
    check('soc_kill_tokens_scope_check', sql`${t.scope} IN (${inList(SOC_KILL_TOKEN_SCOPES)})`),
    check(
      'soc_kill_tokens_scope_ref_check',
      sql`(${t.scope} IN (${inList(KILL_SCOPES_WITH_REF)})) = (${t.scopeRefId} IS NOT NULL)`,
    ),
    check('soc_kill_tokens_sha256_length_check', sql`octet_length(${t.tokenSha256}) = 32`),
    check(
      'soc_kill_tokens_uses_check',
      sql`${t.maxUses} >= 1 AND ${t.useCount} >= 0 AND ${t.useCount} <= ${t.maxUses}`,
    ),
    pgPolicy('soc_kill_tokens_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type KillEventRow = typeof killEvents.$inferSelect;
export type NewKillEventRow = typeof killEvents.$inferInsert;
export type SocContactRow = typeof socContacts.$inferSelect;
export type NewSocContactRow = typeof socContacts.$inferInsert;
export type SocKillTokenRow = typeof socKillTokens.$inferSelect;
export type NewSocKillTokenRow = typeof socKillTokens.$inferInsert;
