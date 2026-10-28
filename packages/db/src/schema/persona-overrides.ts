import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  boolean,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { TENANT_PREDICATE } from './columns.js';

/**
 * Tenant persona overrides (REGISTRY-010, CONTEXT_PACK §4.6 / §8.11). One row per (tenant, persona) holds
 * the whitelisted fields a tenant set; a NULL column means "use the persona's base value". The
 * application (`@blackwing/agents` `parsePersonaOverride`) is the first gate; these checks are the second.
 * Tools, the intrusiveness ceiling and the model map are not columns here, by design.
 *
 * Rows are upserted by the API and never deleted: a reset is a PUT with no fields, and the history of
 * changes lives in the audit ledger (`persona.override_changed`). The forward-only migration is generated
 * from this file (`pnpm db:generate`) and then reviewed; FORCE ROW LEVEL SECURITY, the grants and the
 * `updated_at` trigger are appended by hand because Drizzle does not model them.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Persona names are lowercase kebab-case (the roster in `@blackwing/agents`). The roster itself is code. */
const PERSONA_NAME_PATTERN = '^[a-z][a-z0-9-]{0,63}$';

/**
 * Mirrors `EFFORT_LEVELS` in `@blackwing/agents`. The API test asserts the two stay equal, so a new level
 * cannot be stored by one side and refused by the other.
 */
export const PERSONA_OVERRIDE_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Mirrors `MAX_OVERRIDE_TURNS` / `MAX_OVERRIDE_BUDGET_USD` in `@blackwing/agents`. */
export const PERSONA_OVERRIDE_MAX_TURNS = 10_000;
export const PERSONA_OVERRIDE_MAX_BUDGET_USD = 10_000;

export const personaOverrides = pgTable(
  'persona_overrides',
  {
    tenantId: uuid('tenant_id').notNull(),
    /** The persona name the override applies to (`PersonaName`). */
    persona: text('persona').notNull(),
    effort: text('effort'),
    maxTurns: integer('max_turns'),
    /** USD; clamped to the persona's own default by the application. */
    maxBudgetUsd: doublePrecision('max_budget_usd'),
    lowerStandardTier: boolean('lower_standard_tier'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'persona_overrides_pk', columns: [t.tenantId, t.persona] }),
    check(
      'persona_overrides_persona_check',
      sql`${t.persona} ~ ${sql.raw(`'${PERSONA_NAME_PATTERN}'`)}`,
    ),
    check(
      'persona_overrides_effort_check',
      sql`${t.effort} IS NULL OR ${t.effort} IN (${sql.raw(PERSONA_OVERRIDE_EFFORT_VALUES.map((v) => `'${v}'`).join(', '))})`,
    ),
    check(
      'persona_overrides_max_turns_check',
      sql`${t.maxTurns} IS NULL OR ${t.maxTurns} BETWEEN 1 AND ${sql.raw(String(PERSONA_OVERRIDE_MAX_TURNS))}`,
    ),
    check(
      'persona_overrides_max_budget_check',
      sql`${t.maxBudgetUsd} IS NULL OR (${t.maxBudgetUsd} > 0 AND ${t.maxBudgetUsd} <= ${sql.raw(String(PERSONA_OVERRIDE_MAX_BUDGET_USD))})`,
    ),
    // The canonical tenant policy (`rlsPolicySql` shape): no TO clause, access is granted to bw_app only.
    pgPolicy('persona_overrides_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type PersonaOverrideRow = typeof personaOverrides.$inferSelect;
export type NewPersonaOverrideRow = typeof personaOverrides.$inferInsert;
