import type { CostProvider, CostStage, RunState } from '@blackwing/contracts';

/** A run as ingestion needs it: its §3.3 state (for the stage) and its pinned price table version (§8.9). */
export interface CostRunRef {
  readonly state: RunState;
  /** `null` when the run has not been pinned to a price table yet. */
  readonly priceTableVersion: number | null;
}

/** One `price_tables` row, numerics as the database returns them (decimal strings, never floats). */
export interface CostPriceRow {
  readonly id: string;
  readonly inputPerMtok: string;
  readonly outputPerMtok: string;
  readonly cacheWritePerMtok: string;
  readonly cacheReadPerMtok: string;
}

/** A `cost_ledger` row to insert. `runId` and `priceTableId` are null on an unattributed or unpriced row. */
export interface CostLedgerInsert {
  readonly runId: string | null;
  readonly subtaskId: null;
  readonly agentSessionId: string | null;
  readonly stage: CostStage;
  readonly persona: string | null;
  readonly provider: CostProvider;
  readonly model: string;
  readonly priceTableId: string | null;
  readonly needsPricing: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: string;
  readonly usageEventId: string;
  readonly occurredAt: string;
}

/**
 * The database side of ingestion. Every method runs in one tenant transaction (`withTenant`, RLS, fail
 * closed), so tenant B's lookups can never see tenant A's runs or ledger rows.
 */
export interface CostIngestStore {
  /** The run in this tenant, or `undefined` (also for another tenant's run: RLS hides it). */
  findRun(tenantId: string, runId: string): Promise<CostRunRef | undefined>;
  /** The price row for an exact model at a pinned version. Price tables are platform data, readable by tenants. */
  findPrice(
    tenantId: string,
    key: { readonly provider: CostProvider; readonly model: string; readonly version: number },
  ): Promise<CostPriceRow | undefined>;
  /**
   * Inserts the row keyed on `(tenant_id, usage_event_id)`. Resolves `true` when a row was written and `false`
   * when the event was already recorded (a replay is a no-op, never a second row).
   */
  insertLedgerRow(tenantId: string, row: CostLedgerInsert): Promise<boolean>;
}

/** Ingestion counters and the lag histogram (OBS wires these to Prometheus; see `createOtelCostIngestMetrics`). */
export interface CostIngestMetrics {
  /** `cost_ingest_events_total{outcome}`: `recorded`, `duplicate` (replay) or `unpriced`. */
  event(outcome: 'recorded' | 'duplicate' | 'unpriced'): void;
  /** `cost_ingest_unpriced_total{reason}`: usage recorded at zero cost because it could not be priced. */
  unpriced(reason: string): void;
  /** `cost_ingest_lag_ms`: milliseconds from the event's `occurredAt` to ingestion. */
  lagMs(ms: number): void;
}
