import type { CostLedgerInsert, CostPriceRow } from './ports.js';
import type { CostProvider, CostStage, RunState } from '@blackwing/contracts';

/**
 * Pure attribution and pricing for one usage event (COST-002). No I/O: the ingestion module feeds it the
 * run and the price row it looked up, so every rule here is unit-testable.
 */

/** Stage a run phase is attributed to. An unknown or absent run falls back to `other`. */
const STAGE_BY_RUN_STATE: Readonly<Partial<Record<RunState, CostStage>>> = {
  recon: 'recon',
  planning: 'planning',
  awaiting_gate1: 'planning',
  approved: 'planning',
  executing: 'execution',
  paused: 'execution',
  validating: 'validation',
  awaiting_gate3: 'validation',
  released: 'reporting',
  reporting: 'reporting',
  completed: 'reporting',
};

export function stageForRunState(state: RunState | undefined): CostStage {
  return (state === undefined ? undefined : STAGE_BY_RUN_STATE[state]) ?? 'other';
}

/** Why a row was written unpriced; surfaced as the `reason` of `cost_ingest_unpriced_total`. */
export type UnpricedReason = 'run_unpinned' | 'unknown_model';

/** Price strings carry at most this many decimal places (`COST_PRICE_SCALE`); prices are per million tokens. */
const PRICE_SCALE = 6;
/** `cost_ledger.cost_usd` carries ten decimal places (`COST_USD_SCALE`): the unit of the arithmetic below. */
const USD_SCALE = 10;
/** The decimal base of the fixed-point arithmetic; a named constant keeps the bigint maths lint-clean. */
const DECIMAL_BASE = 10n;
const ONE_UNIT = 1n;
const PRICE_SCALE_FACTOR = DECIMAL_BASE ** BigInt(PRICE_SCALE);
/** One price unit (1e-6 USD per Mtok) times one token is 1e-12 USD, i.e. 1/100 of a `cost_usd` unit. */
const COST_UNITS_PER_PRICE_TOKEN = DECIMAL_BASE ** BigInt(PRICE_SCALE * 2 - USD_SCALE);

/** Exact parse of a `numeric(14,6)` price string into integer micro-units (no float). */
export function priceMicros(decimal: string): bigint {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole) * PRICE_SCALE_FACTOR + BigInt(fraction.padEnd(PRICE_SCALE, '0'));
}

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

/**
 * The USD cost of the usage, as a `cost_usd` decimal string. Each component rounds UP to the next
 * `1e-10` USD (never under-report). Integer arithmetic only.
 */
export function priceUsage(price: CostPriceRow, tokens: TokenCounts): string {
  const components: readonly [number, string][] = [
    [tokens.inputTokens, price.inputPerMtok],
    [tokens.outputTokens, price.outputPerMtok],
    [tokens.cacheWriteTokens, price.cacheWritePerMtok],
    [tokens.cacheReadTokens, price.cacheReadPerMtok],
  ];
  let units = 0n;
  for (const [count, perMtok] of components) {
    const numerator = BigInt(count) * priceMicros(perMtok);
    units += (numerator + COST_UNITS_PER_PRICE_TOKEN - ONE_UNIT) / COST_UNITS_PER_PRICE_TOKEN;
  }
  return formatUsd(units);
}

/** Formats `1e-10` USD units as a fixed ten-place decimal string. */
function formatUsd(units: bigint): string {
  const scale = DECIMAL_BASE ** BigInt(USD_SCALE);
  const fraction = (units % scale).toString().padStart(USD_SCALE, '0');
  return `${units / scale}.${fraction}`;
}

export interface AttributedUsage {
  readonly runId: string | null;
  readonly stage: CostStage;
  readonly persona: string | null;
  readonly agentSessionId: string | null;
  readonly provider: CostProvider;
  readonly model: string;
  readonly usageEventId: string;
  readonly occurredAt: string;
  readonly tokens: TokenCounts;
}

/**
 * The ledger row for one usage event. A priced row is pinned to the run's price table and costed; an
 * unpriced row keeps every count, carries no table and a zero cost, and names why it is unpriced.
 */
export function buildLedgerRow(
  usage: AttributedUsage,
  pricing:
    | { readonly ok: true; readonly price: CostPriceRow }
    | { readonly ok: false; readonly reason: UnpricedReason },
): { readonly row: CostLedgerInsert; readonly unpriced: UnpricedReason | null } {
  const base = {
    runId: usage.runId,
    subtaskId: null,
    agentSessionId: usage.agentSessionId,
    stage: usage.stage,
    persona: usage.persona,
    provider: usage.provider,
    model: usage.model,
    inputTokens: usage.tokens.inputTokens,
    outputTokens: usage.tokens.outputTokens,
    cacheWriteTokens: usage.tokens.cacheWriteTokens,
    cacheReadTokens: usage.tokens.cacheReadTokens,
    usageEventId: usage.usageEventId,
    occurredAt: usage.occurredAt,
  } as const;
  if (pricing.ok) {
    return {
      unpriced: null,
      row: {
        ...base,
        priceTableId: pricing.price.id,
        needsPricing: false,
        costUsd: priceUsage(pricing.price, usage.tokens),
      },
    };
  }
  return {
    unpriced: pricing.reason,
    row: { ...base, priceTableId: null, needsPricing: true, costUsd: '0' },
  };
}
