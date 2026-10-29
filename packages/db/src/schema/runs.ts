import { sql } from 'drizzle-orm';
import { check, pgPolicy, pgTable, text, unique } from 'drizzle-orm/pg-core';

import { RUN_STATES } from '@blackwing/contracts';

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
    ...stateVersion(),
    ...timestamps(),
  },
  (t) => [
    tenantIdIndex('runs', t.tenantId),
    // Target of the composite foreign keys from child tables: a child can never name another tenant's run.
    unique('runs_tenant_id_id_unique').on(t.tenantId, t.id),
    check('runs_state_check', sql`${t.state} IN (${inList(RUN_STATES)})`),
    pgPolicy('runs_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);
