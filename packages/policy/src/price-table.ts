import { createHash } from 'node:crypto';

// OFFLINE-STUB(#563): static pinned price table for POLICY-014 until the versioned per-provider
// pricing service (COST-003, #563) lands. The exported resolver interface (`PriceTableResolver`)
// is the shape #563 will expose, so callers swap implementations without change.

/** USD-micro (1e-6 USD) per million tokens, integers only so hashing and maths are exact. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface PriceTable {
  readonly version: string;
  readonly effectiveFrom: string;
  /** Keyed `provider/model`. */
  readonly entries: Readonly<Record<string, ModelPrice>>;
}

export interface PriceTablePin {
  readonly priceTableVersion: string;
  readonly priceTableSha256: string;
}

export interface TokenUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** Interface compatible with the future COST-003 (#563) resolver. */
export interface PriceTableResolver {
  currentVersion(): string;
  getPriceTable(version: string): PriceTable;
}

export type PriceFailureReason = 'unknown_model' | 'unknown_price_table_version' | 'hash_mismatch';

export class PriceTableError extends Error {
  constructor(
    readonly reason: PriceFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'PriceTableError';
  }
}

/**
 * Tiered pricing approximation: long-context tiers are NOT modelled. Every request is costed at the
 * standard (base) tier rate, which is the cheapest tier, so budgets may under-estimate long-context
 * calls; the model gateway hard caps remain the enforcement point. Cache writes use the 5-minute
 * TTL rate (1.25x input); cache reads are 0.1x input (Opus 5.5 is 0.05x).
 *
 * SUPERSEDED by 2026-10-21: the 5.5-generation rates here were older-generation values. This
 * version stays frozen (its digest is recorded) so any run pinned to it replays identically.
 */
export const PRICE_TABLE_2026_10_01: PriceTable = {
  version: '2026-10-01',
  effectiveFrom: '2026-10-01',
  entries: {
    'anthropic/claude-opus-5-5': {
      input: 5_000_000,
      output: 25_000_000,
      cacheRead: 500_000,
      cacheWrite: 6_250_000,
    },
    'anthropic/claude-sonnet-5-5': {
      input: 3_000_000,
      output: 15_000_000,
      cacheRead: 300_000,
      cacheWrite: 3_750_000,
    },
    'anthropic/claude-haiku-5-5': {
      input: 1_000_000,
      output: 5_000_000,
      cacheRead: 100_000,
      cacheWrite: 1_250_000,
    },
    'anthropic/claude-sonnet-4-5': {
      input: 3_000_000,
      output: 15_000_000,
      cacheRead: 300_000,
      cacheWrite: 3_750_000,
    },
    'anthropic/claude-opus-4-1': {
      input: 15_000_000,
      output: 75_000_000,
      cacheRead: 1_500_000,
      cacheWrite: 18_750_000,
    },
  },
};

/**
 * Tiered pricing approximation: long-context tiers are NOT modelled. Every request is costed at the
 * standard (base) tier rate. Known edge case: Haiku 5.5 prompts over 100K tokens bill at
 * $0.50 / $2.50 per MTok (5x the base tier), so base-tier costing UNDER-estimates them; the model
 * gateway hard caps remain the enforcement point. Cache writes use the 5-minute TTL rate (1.25x
 * input); cache reads are 0.05x input for Opus 5.5 and 0.1x input for the other models (the Haiku
 * 5.5 cache-read multiplier is assumed). These are first-party Anthropic API rates; Bedrock/Vertex
 * partner pricing is not modelled.
 *
 * Values must be re-checked against current published provider pricing whenever a version is cut.
 */
export const PRICE_TABLE_2026_10_21: PriceTable = {
  version: '2026-10-21',
  effectiveFrom: '2026-10-21',
  entries: {
    'anthropic/claude-opus-5-5': {
      input: 4_000_000,
      output: 20_000_000,
      cacheRead: 200_000,
      cacheWrite: 5_000_000,
    },
    'anthropic/claude-sonnet-5-5': {
      input: 2_000_000,
      output: 10_000_000,
      cacheRead: 200_000,
      cacheWrite: 2_500_000,
    },
    'anthropic/claude-haiku-5-5': {
      input: 100_000,
      output: 500_000,
      cacheRead: 10_000,
      cacheWrite: 125_000,
    },
    'anthropic/claude-sonnet-4-5': {
      input: 3_000_000,
      output: 15_000_000,
      cacheRead: 300_000,
      cacheWrite: 3_750_000,
    },
    'anthropic/claude-opus-4-1': {
      input: 15_000_000,
      output: 75_000_000,
      cacheRead: 1_500_000,
      cacheWrite: 18_750_000,
    },
  },
};

/** Canonical JSON: keys sorted at every level so the digest is stable. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function priceTableDigest(table: PriceTable): string {
  return createHash('sha256').update(canonical(table)).digest('hex');
}

function deepFreeze<T>(t: T): T {
  if (t !== null && typeof t === 'object') {
    for (const v of Object.values(t)) deepFreeze(v);
    Object.freeze(t);
  }
  return t;
}

/**
 * Released versions and their recorded content hashes. A released version is immutable: editing a
 * table without cutting a new version makes `getPriceTable` (and the contract test) fail.
 */
const RELEASED: ReadonlyMap<string, { table: PriceTable; sha256: string }> = new Map([
  [
    PRICE_TABLE_2026_10_01.version,
    {
      table: deepFreeze(PRICE_TABLE_2026_10_01),
      sha256: '7f0d5295cf6c90a0f9862eb746732ec7229d66146b0c9d4728f4714bbd9fd667',
    },
  ],
  [
    PRICE_TABLE_2026_10_21.version,
    {
      table: deepFreeze(PRICE_TABLE_2026_10_21),
      sha256: '03e3fcbceabd6f0059ee480e8847c2ea258968acc02ac02c66fe22909481d7bb',
    },
  ],
]);

export const CURRENT_PRICE_TABLE_VERSION = PRICE_TABLE_2026_10_21.version;

export function currentVersion(): string {
  return CURRENT_PRICE_TABLE_VERSION;
}

/** Fail closed on a missing version (e.g. at replay) or a table whose content no longer matches. */
export function getPriceTable(version: string): PriceTable {
  const rel = RELEASED.get(version);
  if (!rel) {
    throw new PriceTableError(
      'unknown_price_table_version',
      `unknown price table version "${version}"`,
    );
  }
  if (priceTableDigest(rel.table) !== rel.sha256) {
    throw new PriceTableError(
      'hash_mismatch',
      `price table "${version}" content does not match its recorded hash`,
    );
  }
  return rel.table;
}

export function priceTableSha256(version: string): string {
  getPriceTable(version);
  return RELEASED.get(version)?.sha256 ?? '';
}

/** Pin recorded in the per-run policy snapshot (#837). Defaults to the current version. */
export function priceTablePin(version: string = currentVersion()): PriceTablePin {
  return { priceTableVersion: version, priceTableSha256: priceTableSha256(version) };
}

export const staticPriceTableResolver: PriceTableResolver = { currentVersion, getPriceTable };

/** Re-resolve a run's pinned table by version and verify the recorded hash (replay). */
export function resolvePinnedTable(
  pin: PriceTablePin,
  resolver: PriceTableResolver = staticPriceTableResolver,
): PriceTable {
  const table = resolver.getPriceTable(pin.priceTableVersion);
  if (priceTableDigest(table) !== pin.priceTableSha256) {
    throw new PriceTableError(
      'hash_mismatch',
      `pinned hash does not match table "${pin.priceTableVersion}"`,
    );
  }
  return table;
}

const ZERO = 0n;
const ONE = 1n;
const MTOK = 1_000_000n;

function component(tokens: number | undefined, pricePerMTok: number): bigint {
  if (tokens === undefined || tokens === 0) return ZERO;
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError('token counts must be non-negative safe integers');
  }
  // Round UP each component to the next micro-USD: never under-report cost.
  return (BigInt(tokens) * BigInt(pricePerMTok) + MTOK - ONE) / MTOK;
}

export type CostResult =
  | { readonly ok: true; readonly costMicroUsd: number; readonly pin: PriceTablePin }
  | { readonly ok: false; readonly reason: PriceFailureReason; readonly detail: string };

export interface CostOptions {
  /** Called on every denial so callers can emit the unknown-model-denial metric / log. */
  readonly onDeny?: (reason: PriceFailureReason, detail: string) => void;
  readonly resolver?: PriceTableResolver;
}

/** Cost a usage record against the run's pinned table. Unknown model or version denies; never zero. */
export function computeCost(
  pin: PriceTablePin,
  model: string,
  usage: TokenUsage,
  opts: CostOptions = {},
): CostResult {
  const deny = (reason: PriceFailureReason, detail: string): CostResult => {
    opts.onDeny?.(reason, detail);
    return { ok: false, reason, detail };
  };
  let table: PriceTable;
  try {
    table = resolvePinnedTable(pin, opts.resolver);
  } catch (e) {
    if (e instanceof PriceTableError) return deny(e.reason, e.message);
    throw e;
  }
  const price = Object.hasOwn(table.entries, model) ? table.entries[model] : undefined;
  if (!price)
    return deny('unknown_model', `no price for model "${model}" in price table ${table.version}`);
  const micro =
    component(usage.input, price.input) +
    component(usage.output, price.output) +
    component(usage.cacheRead, price.cacheRead) +
    component(usage.cacheWrite, price.cacheWrite);
  return { ok: true, costMicroUsd: Number(micro), pin };
}
