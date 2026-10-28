import { z } from 'zod';

import { AppError, ValidationError } from '@blackwing/errors';

import {
  EFFORT_LEVELS,
  type EffortLevel,
  type PersonaDefinition,
  type PersonaName,
} from './persona.js';

import type { EvalFlags } from './tier.js';

/**
 * Tenant persona overrides (REGISTRY-010, CONTEXT_PACK §4.6 / §8.9 / §8.11).
 *
 * A tenant may tune a persona's effort, turn budget, spend budget and eval-driven tier lowering. It may
 * never change what a persona is allowed to do: tools, the intrusiveness ceiling and the model base map
 * stay with the persona definition. The whitelist is deny-by-default: any key outside
 * {@link PERSONA_OVERRIDE_FIELDS} is refused with `OVERRIDE_FIELD_FORBIDDEN`, whatever its value.
 * Values that exceed the persona's own bounds are clamped down to them, never raised above them.
 */

/** The only fields a tenant may override. Adding one is a reviewed change to the safety surface. */
export const PERSONA_OVERRIDE_FIELDS = [
  'effort',
  'maxTurns',
  'maxBudgetUsd',
  'lowerStandardTier',
] as const;
export type PersonaOverrideField = (typeof PERSONA_OVERRIDE_FIELDS)[number];

/** Upper bounds on what a tenant may request. Clamping against the persona happens after these. */
const MAX_OVERRIDE_TURNS = 10_000;
const MAX_OVERRIDE_BUDGET_USD = 10_000;
/** Longest forbidden key echoed back in an error message; the key is untrusted input. */
const MAX_ECHOED_KEY_LENGTH = 64;

/** Refusal of a field outside the whitelist (`OVERRIDE_FIELD_FORBIDDEN`, 403). */
export class PersonaOverrideFieldError extends AppError {
  declare readonly code: 'OVERRIDE_FIELD_FORBIDDEN';
  /** The refused keys, truncated; safe to show the caller. */
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    const shown = fields.map((f) => f.slice(0, MAX_ECHOED_KEY_LENGTH));
    super('OVERRIDE_FIELD_FORBIDDEN', `OVERRIDE_FIELD_FORBIDDEN: ${shown.join(', ')}`);
    this.name = 'PersonaOverrideFieldError';
    this.fields = Object.freeze(shown);
  }
}

export const personaOverrideSchema = z.strictObject({
  effort: z.enum(EFFORT_LEVELS).optional(),
  maxTurns: z.number().int().min(1).max(MAX_OVERRIDE_TURNS).optional(),
  maxBudgetUsd: z.number().positive().max(MAX_OVERRIDE_BUDGET_USD).optional(),
  lowerStandardTier: z.boolean().optional(),
});

/** A validated override. An absent field means "use the persona's base value". */
export type PersonaOverride = z.output<typeof personaOverrideSchema>;

/**
 * Parses an untrusted override body. The whitelist runs first, so a forbidden key is reported as such
 * even when its value would also be invalid. Throws {@link PersonaOverrideFieldError} or
 * {@link ValidationError}; never returns a partial result.
 */
export function parsePersonaOverride(input: unknown): PersonaOverride {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('persona override must be a JSON object', {
      detail: 'the body must be a JSON object',
    });
  }
  const allowed: readonly string[] = PERSONA_OVERRIDE_FIELDS;
  const forbidden = Object.keys(input).filter((key) => !allowed.includes(key));
  if (forbidden.length > 0) throw new PersonaOverrideFieldError(forbidden);

  const parsed = personaOverrideSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ValidationError('invalid persona override', { detail });
  }
  return parsed.data;
}

/** A bound the tenant asked for that the persona's own limit reduced. */
export interface PersonaOverrideClamp {
  readonly field: 'maxTurns' | 'maxBudgetUsd';
  readonly requested: number;
  readonly applied: number;
}

/** The settings a run uses for one persona, after the base definition and any override are merged. */
export interface EffectivePersonaSettings {
  readonly name: PersonaName;
  readonly tierAlias: PersonaDefinition['tierAlias'];
  readonly effort: EffortLevel;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  /** Feeds `resolveTier` (REGISTRY-003); `lowerStandard` is set only when the override applies. */
  readonly evalFlags: EvalFlags;
  /** Whitelisted fields of the override that are in effect (a clamped value still counts). */
  readonly overridden: readonly PersonaOverrideField[];
  /** Requested values that were reduced to the persona's bounds, for logs and metrics. */
  readonly clamped: readonly PersonaOverrideClamp[];
}

/**
 * Merges a persona's base definition with an optional tenant override. Override precedence applies to
 * each whitelisted field; `maxTurns` and `maxBudgetUsd` are clamped to the persona's own limits.
 * `lowerStandardTier` only has an effect on a `standard`-tier persona; elsewhere it is ignored. With no
 * override, the result is exactly the base definition.
 */
export function resolveEffectivePersona(
  persona: PersonaDefinition,
  override: PersonaOverride | null,
): EffectivePersonaSettings {
  const overridden: PersonaOverrideField[] = [];
  const clamped: PersonaOverrideClamp[] = [];

  let effort = persona.effort;
  if (override?.effort !== undefined) {
    effort = override.effort;
    overridden.push('effort');
  }

  let maxTurns = persona.maxTurns;
  if (override?.maxTurns !== undefined) {
    maxTurns = Math.min(override.maxTurns, persona.maxTurns);
    if (maxTurns !== override.maxTurns) {
      clamped.push({ field: 'maxTurns', requested: override.maxTurns, applied: maxTurns });
    }
    overridden.push('maxTurns');
  }

  let maxBudgetUsd = persona.maxBudgetUsdDefault;
  if (override?.maxBudgetUsd !== undefined) {
    maxBudgetUsd = Math.min(override.maxBudgetUsd, persona.maxBudgetUsdDefault);
    if (maxBudgetUsd !== override.maxBudgetUsd) {
      clamped.push({
        field: 'maxBudgetUsd',
        requested: override.maxBudgetUsd,
        applied: maxBudgetUsd,
      });
    }
    overridden.push('maxBudgetUsd');
  }

  const lowerStandard = override?.lowerStandardTier === true && persona.tierAlias === 'standard';
  if (lowerStandard) overridden.push('lowerStandardTier');

  return {
    name: persona.name,
    tierAlias: persona.tierAlias,
    effort,
    maxTurns,
    maxBudgetUsd,
    evalFlags: lowerStandard ? { lowerStandard: true } : {},
    overridden,
    clamped,
  };
}
