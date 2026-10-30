import { sql } from 'drizzle-orm';
import {
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
  uniqueIndex,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core';

import { ONCALL_LEVELS, ONCALL_ORDER_INDEX_MAX } from '@blackwing/contracts';

import { idColumn, stateVersion, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';

/**
 * Gate 2 on-call roster (GATE2-003, F13/F31, CONTEXT_PACK §7, §8.4, §8.6). A tenant has at most one
 * active roster; its members sit on an escalation ladder (`level`, then `order_index`); optional
 * schedule windows say when a rotating member is on call. Every table is tenant-scoped (RLS) and
 * members and schedules reference their roster through a tenant-scoped foreign key, so a row can
 * never point at another tenant's roster. The forward-only migration in `migrations/` is generated
 * from this file (`pnpm db:generate`) and then reviewed; FORCE ROW LEVEL SECURITY, the grants and the
 * `updated_at` triggers are appended by hand because Drizzle does not model them.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const tenantPolicy = (table: string) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: TENANT_PREDICATE,
    withCheck: TENANT_PREDICATE,
  });

export const oncallRosters = pgTable(
  'oncall_rosters',
  {
    id: idColumn(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    /** IANA zone the rotation boundaries are read in (never the server's local zone). */
    timezone: text('timezone').notNull(),
    active: boolean('active').notNull().default(true),
    /** Optimistic concurrency: the API ETag is `"v<state_version>"` (§9). */
    ...stateVersion(),
    ...timestamps(),
  },
  (t) => [
    // Target of the tenant-scoped foreign keys below (no cross-tenant references).
    unique('oncall_rosters_tenant_id_id_key').on(t.tenantId, t.id),
    unique('oncall_rosters_tenant_name_key').on(t.tenantId, t.name),
    // At most one active roster per tenant: the resolver never has to choose between two.
    uniqueIndex('oncall_rosters_one_active_idx')
      .on(t.tenantId)
      .where(sql`${t.active}`),
    check('oncall_rosters_name_check', sql`length(btrim(${t.name})) > 0`),
    check('oncall_rosters_timezone_check', sql`length(btrim(${t.timezone})) > 0`),
    tenantPolicy('oncall_rosters'),
  ],
);

export const oncallMembers = pgTable(
  'oncall_members',
  {
    id: idColumn(),
    tenantId: uuid('tenant_id').notNull(),
    rosterId: uuid('roster_id').notNull(),
    /** A user reference only; no name, e-mail or phone is stored here (§8.6 privacy). */
    userId: uuid('user_id').notNull(),
    /** Escalation level: 0 primary, 1 secondary, 2 manager. */
    level: integer('level').notNull(),
    /** Notification channel ids (NOTIFY) this member is paged on; empty means not pageable. */
    channelRefs: jsonb('channel_refs').$type<string[]>().notNull().default([]),
    orderIndex: integer('order_index').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('oncall_members_tenant_roster_idx').on(t.tenantId, t.rosterId),
    // Deterministic order inside a level, and one seat per user per level.
    unique('oncall_members_position_key').on(t.rosterId, t.level, t.orderIndex),
    unique('oncall_members_seat_key').on(t.rosterId, t.level, t.userId),
    foreignKey({
      name: 'oncall_members_roster_fk',
      columns: [t.tenantId, t.rosterId],
      foreignColumns: [oncallRosters.tenantId, oncallRosters.id],
    }).onDelete('cascade'),
    check(
      'oncall_members_level_check',
      sql`${t.level} BETWEEN ${sql.raw(String(ONCALL_LEVELS[0]))} AND ${sql.raw(String(ONCALL_LEVELS[ONCALL_LEVELS.length - 1]))}`,
    ),
    check(
      'oncall_members_order_index_check',
      sql`${t.orderIndex} BETWEEN 0 AND ${sql.raw(String(ONCALL_ORDER_INDEX_MAX))}`,
    ),
    check('oncall_members_channel_refs_check', sql`jsonb_typeof(${t.channelRefs}) = 'array'`),
    tenantPolicy('oncall_members'),
  ],
);

export const oncallSchedules = pgTable(
  'oncall_schedules',
  {
    id: idColumn(),
    tenantId: uuid('tenant_id').notNull(),
    rosterId: uuid('roster_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** UTC instants. A window is half-open: on call from `starts_at` (inclusive) to `ends_at` (exclusive). */
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('oncall_schedules_tenant_roster_window_idx').on(t.tenantId, t.rosterId, t.startsAt),
    foreignKey({
      name: 'oncall_schedules_roster_fk',
      columns: [t.tenantId, t.rosterId],
      foreignColumns: [oncallRosters.tenantId, oncallRosters.id],
    }).onDelete('cascade'),
    check('oncall_schedules_window_check', sql`${t.endsAt} > ${t.startsAt}`),
    tenantPolicy('oncall_schedules'),
  ],
);

export type OncallRosterRow = typeof oncallRosters.$inferSelect;
export type NewOncallRosterRow = typeof oncallRosters.$inferInsert;
export type OncallMemberRow = typeof oncallMembers.$inferSelect;
export type NewOncallMemberRow = typeof oncallMembers.$inferInsert;
export type OncallScheduleRow = typeof oncallSchedules.$inferSelect;
export type NewOncallScheduleRow = typeof oncallSchedules.$inferInsert;
