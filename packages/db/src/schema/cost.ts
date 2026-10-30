import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  numeric,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  COST_PROVIDERS,
  COST_STAGES,
  COST_TOKENS_MAX,
  COST_PRICE_MAX_INTEGER_DIGITS,
  COST_PRICE_SCALE,
  COST_USD_MAX_INTEGER_DIGITS,
  COST_USD_SCALE,
} from '@blackwing/contracts';

import { idColumn, tenantIdColumn, tenantIdIndex, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';
import { operatorRole } from './kill.js';

/**
 * Cost accounting storage (COST-001, CONTEXT_PACK §4.4, §7, §8.6, §8.9). Two tables:
 *
 * - `price_tables`: versioned, platform-level reference prices (not tenant data). Tenants read them;
 *   only the platform operator path (`bw_operator`) writes them, and a price change is a new version.
 * - `cost_ledger`: the append-only record of priced usage. Every row is tenant-scoped (RLS) and pins
 *   the `price_tables` row it was priced with, so a cost is never re-derived against "current" prices.
 *
 * Money is `numeric` (never float). The forward-only migration in `migrations/` is generated from this
 * file (`pnpm db:generate`) and then reviewed; FORCE ROW LEVEL SECURITY, the grants and the
 * `updated_at` trigger are appended by hand because Drizzle does not model them.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/** Exact model ids carry no date suffix (see `costModelIdSchema`); the database enforces it too. */
const MODEL_ID_CHECK = sql`${sql.raw('"model"')} ~ '^[a-z0-9][a-z0-9.-]*$' AND ${sql.raw('"model"')} !~ '-[0-9]{8}$'`;

export const priceTables = pgTable(
  'price_tables',
  {
    id: idColumn(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    inputPerMtok: numeric('input_per_mtok', {
      precision: COST_PRICE_MAX_INTEGER_DIGITS + COST_PRICE_SCALE,
      scale: COST_PRICE_SCALE,
    }).notNull(),
    outputPerMtok: numeric('output_per_mtok', {
      precision: COST_PRICE_MAX_INTEGER_DIGITS + COST_PRICE_SCALE,
      scale: COST_PRICE_SCALE,
    }).notNull(),
    cacheWritePerMtok: numeric('cache_write_per_mtok', {
      precision: COST_PRICE_MAX_INTEGER_DIGITS + COST_PRICE_SCALE,
      scale: COST_PRICE_SCALE,
    }).notNull(),
    cacheReadPerMtok: numeric('cache_read_per_mtok', {
      precision: COST_PRICE_MAX_INTEGER_DIGITS + COST_PRICE_SCALE,
      scale: COST_PRICE_SCALE,
    }).notNull(),
    currency: text('currency').notNull().default('USD'),
    effectiveFrom: ts('effective_from').notNull(),
    /** Digest of the canonical table body: pins the exact prices a run was costed with (§8.9). */
    sha256: text('sha256').notNull(),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('price_tables_provider_model_version_key').on(t.provider, t.model, t.version),
    check('price_tables_provider_check', sql`${t.provider} IN (${inList(COST_PROVIDERS)})`),
    check('price_tables_model_check', MODEL_ID_CHECK),
    check('price_tables_version_check', sql`${t.version} >= 1`),
    check(
      'price_tables_prices_check',
      sql`${t.inputPerMtok} >= 0 AND ${t.outputPerMtok} >= 0 AND ${t.cacheWritePerMtok} >= 0 AND ${t.cacheReadPerMtok} >= 0`,
    ),
    check('price_tables_currency_check', sql`${t.currency} = 'USD'`),
    check('price_tables_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    // Tenants read the reference prices; only the operator path writes them (see migration).
    pgPolicy('price_tables_read', {
      as: 'permissive',
      for: 'select',
      to: 'public',
      using: sql`true`,
    }),
    pgPolicy('price_tables_operator_write', {
      as: 'permissive',
      for: 'all',
      to: operatorRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

export const costLedger = pgTable(
  'cost_ledger',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    runId: uuid('run_id').notNull(),
    subtaskId: uuid('subtask_id'),
    agentSessionId: uuid('agent_session_id'),
    stage: text('stage').notNull(),
    /** Null for orchestrator overhead that no persona owns. */
    persona: text('persona'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** The pinned price table this row was priced with (§8.9). Never resolved against "current". */
    priceTableId: uuid('price_table_id')
      .notNull()
      .references(() => priceTables.id),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull(),
    costUsd: numeric('cost_usd', {
      precision: COST_USD_MAX_INTEGER_DIGITS + COST_USD_SCALE,
      scale: COST_USD_SCALE,
    }).notNull(),
    /** The gateway's usage event id: the idempotency key for ingestion (a retry never double-counts). */
    usageEventId: text('usage_event_id').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('cost_ledger_tenant_usage_event_key').on(t.tenantId, t.usageEventId),
    tenantIdIndex('cost_ledger', t.tenantId),
    index('cost_ledger_tenant_run_idx').on(t.tenantId, t.runId),
    index('cost_ledger_tenant_occurred_at_idx').on(t.tenantId, t.occurredAt),
    index('cost_ledger_tenant_model_idx').on(t.tenantId, t.model),
    index('cost_ledger_price_table_idx').on(t.priceTableId),
    check('cost_ledger_stage_check', sql`${t.stage} IN (${inList(COST_STAGES)})`),
    check('cost_ledger_provider_check', sql`${t.provider} IN (${inList(COST_PROVIDERS)})`),
    check('cost_ledger_model_check', MODEL_ID_CHECK),
    check(
      'cost_ledger_tokens_check',
      sql`${t.inputTokens} BETWEEN 0 AND ${sql.raw(String(COST_TOKENS_MAX))}
        AND ${t.outputTokens} BETWEEN 0 AND ${sql.raw(String(COST_TOKENS_MAX))}
        AND ${t.cacheWriteTokens} BETWEEN 0 AND ${sql.raw(String(COST_TOKENS_MAX))}
        AND ${t.cacheReadTokens} BETWEEN 0 AND ${sql.raw(String(COST_TOKENS_MAX))}`,
    ),
    check('cost_ledger_cost_check', sql`${t.costUsd} >= 0`),
    check('cost_ledger_usage_event_check', sql`length(btrim(${t.usageEventId})) > 0`),
    check(
      'cost_ledger_persona_check',
      sql`${t.persona} IS NULL OR length(btrim(${t.persona})) > 0`,
    ),
    pgPolicy('cost_ledger_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);
