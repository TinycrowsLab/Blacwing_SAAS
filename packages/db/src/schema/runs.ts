import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { RUN_STATES, runPauseReasonSchema } from '@blackwing/contracts';

import { idColumn, stateVersion, tenantIdColumn, tenantIdIndex, timestamps } from '../columns.js';
import { TENANT_PREDICATE } from './columns.js';

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/**
 * Minimal `runs` table (PLAN-001 foreign-key target, CONTEXT_PACK §3.3 and §7). The full run model
 * (mode, objective, pinned manifest, budgets, timers) belongs to the ORCH epic and extends this table
 * with its own migrations. Only the identity, the tenant anchor, the §3.3 state and the optimistic
 * concurrency column live here, so the test-plan tables can reference a real, tenant-scoped run.
 *
 * Tenant table: FORCE ROW LEVEL SECURITY and the grants are appended by hand in the migration.
 */
export const runs = pgTable(
  'runs',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    /** §3.3 run state; the transition rules live in `packages/domain/run`. */
    state: text('state', { enum: RUN_STATES }).notNull().default('draft'),
    /** Why the run is `paused` (§3.3, `PausedReason`); null in every other state. */
    pauseReason: text('pause_reason'),
    /** The state a `paused` run resumes to (`resumeTo`); null in every other state. */
    resumeTo: text('resume_to', { enum: RUN_STATES }),
    /** The `run_…` public id (`publicId('run', id)`). Null until the run is given one (REPORT-001 needs it). */
    publicId: text('public_id'),
    /**
     * The `price_tables.version` this run is pinned to (§8.9): usage is priced against it, never against
     * "current". Null until the run is pinned; usage of an unpinned run is recorded as unpriced.
     */
    priceTableVersion: bigint('price_table_version', { mode: 'number' }),
    /** The run manifest the report reads (`runManifestSchema`): mode, objective, window, assets, provenance. */
    manifest: jsonb('manifest').$type<Record<string, unknown>>(),
    ...stateVersion(),
    ...timestamps(),
  },
  (t) => [
    tenantIdIndex('runs', t.tenantId),
    // Target of the composite foreign keys from child tables: a child can never name another tenant's run.
    unique('runs_tenant_id_id_unique').on(t.tenantId, t.id),
    uniqueIndex('runs_public_id_key').on(t.publicId),
    check('runs_public_id_check', sql`${t.publicId} IS NULL OR starts_with(${t.publicId}, 'run_')`),
    check(
      'runs_manifest_check',
      sql`${t.manifest} IS NULL OR jsonb_typeof(${t.manifest}) = 'object'`,
    ),
    check('runs_state_check', sql`${t.state} IN (${inList(RUN_STATES)})`),
    check(
      'runs_price_table_version_check',
      sql`${t.priceTableVersion} IS NULL OR ${t.priceTableVersion} >= 1`,
    ),
    check(
      'runs_pause_reason_check',
      sql`${t.pauseReason} IS NULL OR ${t.pauseReason} IN (${inList(runPauseReasonSchema.options)})`,
    ),
    check(
      'runs_pause_fields_check',
      sql`(${t.state} = 'paused') = (${t.pauseReason} IS NOT NULL AND ${t.resumeTo} IS NOT NULL)`,
    ),
    pgPolicy('runs_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);
