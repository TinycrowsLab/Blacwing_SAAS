import { z } from 'zod';

import { isoDateTimeSchema, uuidV7Schema } from '../primitives.js';

/**
 * Cost accounting contracts (COST-001, CONTEXT_PACK §4.4, §7, §8.9). `price_tables` are versioned
 * platform reference prices; `cost_ledger` is the append-only record of priced usage. Money is
 * never a JavaScript float: prices and costs cross the boundary as decimal strings that match the
 * `numeric` columns of the `@blackwing/db` migration, so the database and these schemas cannot drift.
 */

/** Model providers a price row can be keyed on. */
export const COST_PROVIDERS = ['anthropic', 'bedrock', 'vertex', 'foundry'] as const;
export type CostProvider = (typeof COST_PROVIDERS)[number];
export const costProviderSchema = z.enum(COST_PROVIDERS);

/** Cost stages a ledger row is attributed to. `other` covers orchestrator overhead. */
export const COST_STAGES = [
  'recon',
  'planning',
  'execution',
  'validation',
  'reporting',
  'other',
] as const;
export type CostStage = (typeof COST_STAGES)[number];
export const costStageSchema = z.enum(COST_STAGES);

/** Largest token count one usage event may report. Above it the event is refused, never clamped. */
export const COST_TOKENS_MAX = 1_000_000_000;

/** Largest model price (USD per million tokens) and the decimal places it carries. */
export const COST_PRICE_MAX_INTEGER_DIGITS = 8;
export const COST_PRICE_SCALE = 6;
/** Length bounds of the free-text ledger fields. */
const COST_MODEL_ID_MAX = 100;
const COST_PERSONA_MAX = 64;
const COST_USAGE_EVENT_ID_MAX = 200;

/** Largest priced cost in USD and the decimal places it carries. */
export const COST_USD_MAX_INTEGER_DIGITS = 8;
export const COST_USD_SCALE = 10;

const DECIMAL_PRICE = new RegExp(
  `^\\d{1,${COST_PRICE_MAX_INTEGER_DIGITS}}(?:\\.\\d{1,${COST_PRICE_SCALE}})?$`,
  'u',
);
const DECIMAL_USD = new RegExp(
  `^\\d{1,${COST_USD_MAX_INTEGER_DIGITS}}(?:\\.\\d{1,${COST_USD_SCALE}})?$`,
  'u',
);

/**
 * An exact model ID (`claude-sonnet-5-5`): lower-case, no date suffix. A dated alias such as
 * `-20261001` names a different price than the model, so it is refused (price tables are per model).
 */
export const costModelIdSchema = z
  .string()
  .min(1)
  .max(COST_MODEL_ID_MAX)
  .regex(/^[a-z0-9][a-z0-9.-]*$/u, 'must be a lower-case model id')
  .refine((id) => !/-\d{8}$/u.test(id), 'must not carry a date suffix');

/** A USD price per million tokens, as a decimal string (no float). */
export const costPriceSchema = z.string().regex(DECIMAL_PRICE, 'must be a non-negative decimal');

/** A priced cost in USD, as a decimal string (no float). */
export const costUsdSchema = z.string().regex(DECIMAL_USD, 'must be a non-negative decimal');

/** A token count: an integer from 0 up to {@link COST_TOKENS_MAX}. */
export const costTokensSchema = z.number().int().min(0).max(COST_TOKENS_MAX);

/** A `price_tables` row. Immutable once written: a price change is a new `version`. */
export const priceTableSchema = z.object({
  id: uuidV7Schema,
  provider: costProviderSchema,
  model: costModelIdSchema,
  version: z.number().int().min(1),
  inputPerMtok: costPriceSchema,
  outputPerMtok: costPriceSchema,
  cacheWritePerMtok: costPriceSchema,
  cacheReadPerMtok: costPriceSchema,
  currency: z.literal('USD'),
  effectiveFrom: isoDateTimeSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u, 'must be a lower-case sha256 hex digest'),
  active: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PriceTable = z.infer<typeof priceTableSchema>;

/** One priced usage event, as ingestion (COST-002) writes it. Tenant and ids come from the context. */
export const costLedgerEntrySchema = z.object({
  runId: uuidV7Schema,
  subtaskId: uuidV7Schema.nullable(),
  agentSessionId: uuidV7Schema.nullable(),
  stage: costStageSchema,
  persona: z.string().min(1).max(COST_PERSONA_MAX).nullable(),
  provider: costProviderSchema,
  model: costModelIdSchema,
  priceTableId: uuidV7Schema,
  inputTokens: costTokensSchema,
  outputTokens: costTokensSchema,
  cacheWriteTokens: costTokensSchema,
  cacheReadTokens: costTokensSchema,
  costUsd: costUsdSchema,
  /** The gateway's idempotency key for the usage event: a retry never double-counts. */
  usageEventId: z.string().min(1).max(COST_USAGE_EVENT_ID_MAX),
  occurredAt: isoDateTimeSchema,
});
export type CostLedgerEntry = z.infer<typeof costLedgerEntrySchema>;
