import { AppError } from '@blackwing/errors';

import { type EffortLevel, type PersonaName, type TierAlias, TIER_ALIASES } from './persona.js';

/**
 * Model-tier resolution and per-run pinning (REGISTRY-003, CONTEXT_PACK §4.6 / §8.9).
 *
 * A persona declares a `tierAlias`; this module maps it to an exact, date-suffix-free model ID for
 * the tenant's provider and freezes the result for the run. Provider routing and keys belong to the
 * model gateway; the allowlist is the gateway's, supplied by the caller. Eval-driven lowering is a
 * flag, never a prompt change. Anything unresolvable is rejected, never substituted.
 */

export const MODEL_PROVIDERS = ['anthropic', 'bedrock', 'vertex', 'foundry'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The one tier map (§4.6). `standard` may be lowered to Sonnet via {@link EvalFlags}. */
const TIER_MODELS = {
  deep: 'claude-opus-5-5',
  standard: 'claude-opus-5-5',
  fast: 'claude-haiku-5-5',
} as const satisfies Record<TierAlias, string>;
const LOWERED_STANDARD = 'claude-sonnet-5-5';

/** Bare model IDs the gateway serves by default; callers pass the live gateway allowlist. */
export const DEFAULT_MODEL_ALLOWLIST: readonly string[] = Object.freeze([
  ...new Set([...Object.values(TIER_MODELS), LOWERED_STANDARD]),
]);

const BEDROCK_PREFIX = 'anthropic.';
const DATE_SUFFIX = /-\d{8}$/;

export interface EvalFlags {
  /** Eval-driven rule: run `standard` on Sonnet instead of Opus. Absent means no lowering. */
  readonly lowerStandard?: boolean;
}

/** Failure of tier resolution. Always `MODEL_NOT_ALLOWED`. */
export class TierError extends AppError {
  constructor(message: string) {
    super('MODEL_NOT_ALLOWED', `MODEL_NOT_ALLOWED: ${message}`);
    this.name = 'TierError';
  }
}

function isProvider(value: unknown): value is ModelProvider {
  return typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

function isTier(value: unknown): value is TierAlias {
  return typeof value === 'string' && (TIER_ALIASES as readonly string[]).includes(value);
}

/**
 * Resolves `tierAlias` to the exact model ID for `provider`. Bedrock IDs carry the `anthropic.`
 * prefix; the others are bare. Throws {@link TierError} for an unknown provider or alias, a
 * date-suffixed ID, or a model missing from `allowlist` (bare IDs; default {@link DEFAULT_MODEL_ALLOWLIST}).
 */
export function resolveTier(
  tierAlias: TierAlias,
  provider: ModelProvider,
  evalFlags: EvalFlags = {},
  allowlist: readonly string[] = DEFAULT_MODEL_ALLOWLIST,
): string {
  if (!isProvider(provider)) throw new TierError('unknown provider');
  if (!isTier(tierAlias)) throw new TierError('unknown tier alias');
  const bare =
    tierAlias === 'standard' && evalFlags.lowerStandard === true
      ? LOWERED_STANDARD
      : TIER_MODELS[tierAlias];
  if (DATE_SUFFIX.test(bare) || !allowlist.includes(bare)) {
    throw new TierError(`model ${bare} is not allowed for provider ${provider}`);
  }
  return provider === 'bedrock' ? `${BEDROCK_PREFIX}${bare}` : bare;
}

/** Default effort: `high` for `deep`, `medium` otherwise (§4.6). */
export function defaultEffort(tierAlias: TierAlias): EffortLevel {
  return tierAlias === 'deep' ? 'high' : 'medium';
}

/** The persona fields pinning needs; a persona's own `effort` overrides the tier default. */
export interface PinnablePersona {
  readonly name: PersonaName;
  readonly tierAlias: TierAlias;
  readonly effort?: EffortLevel;
}

export interface PinnedModel {
  readonly model: string;
  readonly effort: EffortLevel;
}

/** Frozen persona to model/effort map recorded in the run manifest (F37). */
export type RunModelPins = Readonly<Record<string, PinnedModel>>;

/** Audit event emitted when a run's models are pinned. */
export const MODELS_PINNED_EVENT = 'run.models_pinned';

/** Resolves every persona and returns the deeply frozen pin set. All-or-nothing: one failure throws. */
export function pinRunModels(
  personas: readonly PinnablePersona[],
  provider: ModelProvider,
  evalFlags: EvalFlags = {},
  allowlist: readonly string[] = DEFAULT_MODEL_ALLOWLIST,
): RunModelPins {
  const pins: Record<string, PinnedModel> = {};
  for (const p of personas) {
    pins[p.name] = Object.freeze({
      model: resolveTier(p.tierAlias, provider, evalFlags, allowlist),
      effort: p.effort ?? defaultEffort(p.tierAlias),
    });
  }
  return Object.freeze(pins);
}
