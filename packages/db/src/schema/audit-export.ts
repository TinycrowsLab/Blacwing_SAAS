import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgPolicy, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { idColumn, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';

/**
 * SIEM export subscriptions (AUDIT-004 / F34, CONTEXT_PACK §7, §8.6, §8.7, §8.8). One row per external
 * destination a tenant streams its audit ledger to. `cursor_seq` is the durable per-destination position:
 * the last `audit_events.seq` the destination has confirmed, so a crash re-delivers from there (at least
 * once) and never skips. Credentials are never stored here: `secret_ref` points at the SECRETS registry and
 * `config` is checked to hold no secret-looking key. Every table is tenant-scoped (RLS). The forward-only
 * migration in `migrations/` is generated from this file (`pnpm db:generate`) and then reviewed; FORCE ROW
 * LEVEL SECURITY and the grants are appended by hand because Drizzle does not model them.
 */

/** Destination kinds a connector can serve (AUDIT-009..012 add the concrete connectors). */
export const AUDIT_EXPORT_KINDS = ['syslog_tls', 'splunk_hec', 'webhook_hmac', 's3'] as const;

/** `active` streams, `paused` stops at the cursor (no gap on resume), `error` is auto-disabled. */
export const AUDIT_EXPORT_STATUSES = ['active', 'paused', 'error'] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

const tenantPolicy = (table: string) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: TENANT_PREDICATE,
    withCheck: TENANT_PREDICATE,
  });

export const auditExportSubscriptions = pgTable(
  'audit_export_subscriptions',
  {
    id: idColumn(),
    tenantId: uuid('tenant_id').notNull(),
    kind: text('kind', { enum: AUDIT_EXPORT_KINDS }).notNull(),
    /** Non-secret destination settings (host, index, path, ...). Never a credential. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Opaque `bw-secret://{tenantId}/{secretId}` reference resolved through SECRETS at delivery time. */
    secretRef: text('secret_ref').notNull(),
    /** Highest `audit_events.seq` already confirmed by the destination (0 = nothing yet). */
    cursorSeq: bigint('cursor_seq', { mode: 'number' }).notNull().default(0),
    status: text('status', { enum: AUDIT_EXPORT_STATUSES }).notNull().default('active'),
    /** Action allow/deny lists applied before delivery (`{ actions?: string[], excludeActions?: string[] }`). */
    filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    index('audit_export_subscriptions_tenant_status_idx').on(t.tenantId, t.status),
    check(
      'audit_export_subscriptions_kind_check',
      sql`${t.kind} IN (${inList(AUDIT_EXPORT_KINDS)})`,
    ),
    check(
      'audit_export_subscriptions_status_check',
      sql`${t.status} IN (${inList(AUDIT_EXPORT_STATUSES)})`,
    ),
    check('audit_export_subscriptions_cursor_check', sql`${t.cursorSeq} >= 0`),
    check('audit_export_subscriptions_config_check', sql`jsonb_typeof(${t.config}) = 'object'`),
    check('audit_export_subscriptions_filters_check', sql`jsonb_typeof(${t.filters}) = 'object'`),
    check(
      'audit_export_subscriptions_secret_ref_check',
      sql`${t.secretRef} ~ '^bw-secret://[A-Za-z0-9][A-Za-z0-9_-]{0,63}/[A-Za-z0-9][A-Za-z0-9_-]{0,63}(\\?v=[1-9][0-9]{0,9})?$'`,
    ),
    tenantPolicy('audit_export_subscriptions'),
  ],
);

export type AuditExportSubscriptionRow = typeof auditExportSubscriptions.$inferSelect;
export type NewAuditExportSubscriptionRow = typeof auditExportSubscriptions.$inferInsert;
