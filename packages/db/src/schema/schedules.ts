import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  BLACKOUT_SCOPES,
  SCHEDULE_CATCH_UP_POLICIES,
  SCHEDULE_CATCH_UP_WINDOW_DEFAULT_MINUTES,
  SCHEDULE_CATCH_UP_WINDOW_MAX_MINUTES,
  SCHEDULE_CRON_MAX,
  SCHEDULE_MODES,
  SCHEDULE_NAME_MAX,
  SCHEDULE_OVERLAP_POLICIES,
  SCHEDULE_TIMEZONE_MAX,
} from '@blackwing/contracts';

import { idColumn, timestamps } from '../columns.js';
import { standingAuthorisations } from './authorisation.js';
import { TENANT_PREDICATE } from './columns.js';

/**
 * Recurring-run schedules and blackout windows (SCHED-001, CONTEXT_PACK §7, §8.6). A schedule binds a cron
 * expression to a standing authorisation and a set of assets; a blackout window suppresses runs for the tenant or
 * for named assets. Both tables are tenant-scoped (RLS). The schedule's SA reference is a tenant-scoped foreign key,
 * so a row can never bind another tenant's authorisation even though the referential check itself runs as the owner.
 * `cron_expr` and `timezone` are opaque text here: their syntax belongs to SCHED-002. The forward-only migration in
 * `migrations/` is generated from this file (`pnpm db:generate`) and then reviewed; FORCE ROW LEVEL SECURITY, the
 * grants and the `updated_at` triggers are appended by hand because Drizzle does not model them.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

const tenantPolicy = (table: string) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: TENANT_PREDICATE,
    withCheck: TENANT_PREDICATE,
  });

export const schedules = pgTable(
  'schedules',
  {
    id: idColumn(),
    tenantId: uuid('tenant_id').notNull(),
    /** Prefixed public id (`sched_…`), a re-encoding of `id`; unique. */
    publicId: text('public_id').notNull(),
    /** UTF-8 text, at most {@link SCHEDULE_NAME_MAX} characters (see `schedules_name_check`). */
    name: text('name').notNull(),
    /** The assets the schedule fires against. Never empty (see `schedules_asset_ids_check`). */
    assetIds: uuid('asset_ids').array().notNull(),
    /** The standing authorisation the schedule runs under. Tenant-scoped foreign key below. */
    saId: uuid('sa_id').notNull(),
    mode: text('mode').notNull(),
    objective: text('objective'),
    /** Opaque cron text; validated by SCHED-002, not here. */
    cronExpr: text('cron_expr').notNull(),
    /** IANA timezone name; only non-emptiness is checked here (SCHED-002 validates the zone). */
    timezone: text('timezone').notNull(),
    overlapPolicy: text('overlap_policy').notNull().default('skip'),
    catchUpPolicy: text('catch_up_policy').notNull().default('skip'),
    catchUpWindowMinutes: integer('catch_up_window_minutes')
      .notNull()
      .default(SCHEDULE_CATCH_UP_WINDOW_DEFAULT_MINUTES),
    /** Request budgets: a JSON object of numbers (never secrets). Null means "use the SA defaults". */
    budgets: jsonb('budgets').$type<Record<string, number>>(),
    enabled: boolean('enabled').notNull().default(true),
    /** Reference to the Temporal schedule that fires this row (SCHED-003). */
    temporalScheduleId: text('temporal_schedule_id'),
    lastFireAt: ts('last_fire_at'),
    nextFireAt: ts('next_fire_at'),
    createdBy: uuid('created_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('schedules_public_id_key').on(t.publicId),
    index('schedules_tenant_enabled_idx').on(t.tenantId, t.enabled),
    index('schedules_tenant_sa_idx').on(t.tenantId, t.saId),
    index('schedules_next_fire_at_idx').on(t.nextFireAt),
    index('schedules_asset_ids_gin_idx').using('gin', t.assetIds),
    foreignKey({
      name: 'schedules_standing_authorisation_fk',
      columns: [t.tenantId, t.saId],
      foreignColumns: [standingAuthorisations.tenantId, standingAuthorisations.id],
    }),
    check(
      'schedules_name_check',
      sql`char_length(${t.name}) BETWEEN 1 AND ${sql.raw(String(SCHEDULE_NAME_MAX))} AND length(btrim(${t.name})) > 0`,
    ),
    check('schedules_asset_ids_check', sql`cardinality(${t.assetIds}) >= 1`),
    check('schedules_mode_check', sql`${t.mode} IN (${inList(SCHEDULE_MODES)})`),
    check(
      'schedules_overlap_policy_check',
      sql`${t.overlapPolicy} IN (${inList(SCHEDULE_OVERLAP_POLICIES)})`,
    ),
    check(
      'schedules_catch_up_policy_check',
      sql`${t.catchUpPolicy} IN (${inList(SCHEDULE_CATCH_UP_POLICIES)})`,
    ),
    check(
      'schedules_catch_up_window_check',
      sql`${t.catchUpWindowMinutes} BETWEEN 0 AND ${sql.raw(String(SCHEDULE_CATCH_UP_WINDOW_MAX_MINUTES))}`,
    ),
    check(
      'schedules_cron_expr_check',
      sql`char_length(${t.cronExpr}) BETWEEN 1 AND ${sql.raw(String(SCHEDULE_CRON_MAX))}`,
    ),
    check(
      'schedules_timezone_check',
      sql`char_length(${t.timezone}) BETWEEN 1 AND ${sql.raw(String(SCHEDULE_TIMEZONE_MAX))} AND length(btrim(${t.timezone})) > 0`,
    ),
    check(
      'schedules_budgets_object_check',
      sql`${t.budgets} IS NULL OR jsonb_typeof(${t.budgets}) = 'object'`,
    ),
    tenantPolicy('schedules'),
  ],
);

export const blackoutWindows = pgTable(
  'blackout_windows',
  {
    id: idColumn(),
    tenantId: uuid('tenant_id').notNull(),
    /** `tenant` covers every asset (and carries no asset ids); `asset` covers the listed assets only. */
    scope: text('scope').notNull(),
    assetIds: uuid('asset_ids').array(),
    /** UTC instants. A window is half-open: suppressed from `starts_at` (inclusive) to `ends_at` (exclusive). */
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('blackout_windows_tenant_window_idx').on(t.tenantId, t.startsAt, t.endsAt),
    index('blackout_windows_asset_ids_gin_idx').using('gin', t.assetIds),
    check('blackout_windows_scope_check', sql`${t.scope} IN (${inList(BLACKOUT_SCOPES)})`),
    check('blackout_windows_window_check', sql`${t.endsAt} > ${t.startsAt}`),
    check(
      'blackout_windows_scope_assets_check',
      sql`(${t.scope} = 'tenant' AND ${t.assetIds} IS NULL) OR (${t.scope} = 'asset' AND coalesce(cardinality(${t.assetIds}), 0) >= 1)`,
    ),
    check(
      'blackout_windows_reason_check',
      sql`${t.reason} IS NULL OR char_length(${t.reason}) <= 2000`,
    ),
    tenantPolicy('blackout_windows'),
  ],
);

export type ScheduleRow = typeof schedules.$inferSelect;
export type NewScheduleRow = typeof schedules.$inferInsert;
export type BlackoutWindowRow = typeof blackoutWindows.$inferSelect;
export type NewBlackoutWindowRow = typeof blackoutWindows.$inferInsert;
