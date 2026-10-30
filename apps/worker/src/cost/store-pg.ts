import { and, eq } from 'drizzle-orm';

import { costLedger, type Database, priceTables, runs, withTenant } from '@blackwing/db';

import type { CostIngestStore } from './ports.js';

/**
 * The Postgres side of usage ingestion (COST-002). Every call is one tenant transaction (`withTenant`, RLS,
 * fail closed). The ledger insert is `ON CONFLICT (tenant_id, usage_event_id) DO NOTHING`, so a replayed event
 * writes nothing; the row is append-only (the runtime role holds no UPDATE, DELETE or TRUNCATE).
 */
export function createPgCostIngestStore(db: Database): CostIngestStore {
  return {
    findRun(tenantId, runId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ state: runs.state, priceTableVersion: runs.priceTableVersion })
          .from(runs)
          .where(eq(runs.id, runId))
          .limit(1);
        return row === undefined
          ? undefined
          : { state: row.state, priceTableVersion: row.priceTableVersion };
      });
    },

    findPrice(tenantId, key) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({
            id: priceTables.id,
            inputPerMtok: priceTables.inputPerMtok,
            outputPerMtok: priceTables.outputPerMtok,
            cacheWritePerMtok: priceTables.cacheWritePerMtok,
            cacheReadPerMtok: priceTables.cacheReadPerMtok,
          })
          .from(priceTables)
          .where(
            and(
              eq(priceTables.provider, key.provider),
              eq(priceTables.model, key.model),
              eq(priceTables.version, key.version),
            ),
          )
          .limit(1);
        return row;
      });
    },

    insertLedgerRow(tenantId, row) {
      return withTenant(db, tenantId, async (tx) => {
        const inserted = await tx
          .insert(costLedger)
          .values({
            tenantId,
            runId: row.runId,
            subtaskId: row.subtaskId,
            agentSessionId: row.agentSessionId,
            stage: row.stage,
            persona: row.persona,
            provider: row.provider,
            model: row.model,
            priceTableId: row.priceTableId,
            needsPricing: row.needsPricing,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheWriteTokens: row.cacheWriteTokens,
            cacheReadTokens: row.cacheReadTokens,
            costUsd: row.costUsd,
            usageEventId: row.usageEventId,
            occurredAt: new Date(row.occurredAt),
          })
          .onConflictDoNothing({ target: [costLedger.tenantId, costLedger.usageEventId] })
          .returning({ id: costLedger.id });
        return inserted.length === 1;
      });
    },
  };
}
