// MENTOR-001 (#420): thresholds of the deterministic stall-detection rules. Every threshold is an env key
// with a default; a tenant-independent process reads them once at load. Per-persona overrides arrive as a
// JSON object keyed by persona name. Invalid values fail the load (fail closed), they are never clamped.
import { z } from 'zod';

/** Largest integer any stall threshold may take. Keeps a typo from disabling a rule with a huge window. */
const MAX_STALL_INT = 100_000;
/** Largest spend window accepted for `STALL_BUDGET_DELTA_USD` (USD). */
const MAX_STALL_BUDGET_USD = 10_000;
/** Longest subtask time box accepted for `STALL_SUBTASK_MAX_MIN` (minutes): one day. */
const MAX_STALL_SUBTASK_MIN = 1_440;
/** Longest JSON text accepted for `STALL_PERSONA_OVERRIDES`. */
const MAX_OVERRIDES_TEXT_LENGTH = 8_192;

const ISSUE_INT = { message: 'must be a positive integer' } as const;
const ISSUE_USD = { message: 'must be a positive decimal USD amount' } as const;
const ISSUE_JSON = { message: 'must be a JSON object' } as const;

/** Positive integer from env text: decimal digits only, no sign, no leading zero, 1..max. */
function zStallInt(max: number): z.ZodType<number, string> {
  return z.string().transform((raw, ctx): number => {
    if (!/^[1-9]\d{0,9}$/.test(raw)) {
      ctx.addIssue({ code: 'custom', ...ISSUE_INT });
      return z.NEVER;
    }
    const value = Number(raw);
    if (value > max) {
      ctx.addIssue({ code: 'custom', message: `must be at most ${String(max)}` });
      return z.NEVER;
    }
    return value;
  });
}

/** Positive USD amount from env text: `1`, `0.5`, `12.25`. No sign, no exponent. */
function zStallUsd(max: number): z.ZodType<number, string> {
  return z.string().transform((raw, ctx): number => {
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/.test(raw)) {
      ctx.addIssue({ code: 'custom', ...ISSUE_USD });
      return z.NEVER;
    }
    const value = Number(raw);
    if (value <= 0 || value > max) {
      ctx.addIssue({
        code: 'custom',
        message: `must be greater than 0 and at most ${String(max)}`,
      });
      return z.NEVER;
    }
    return value;
  });
}

/** The five rule thresholds, in their config-independent shape. */
export const stallThresholdsSchema = z.strictObject({
  /** `no_progress`: consecutive turns without new evidence, subtask change or surface node. */
  noProgressTurns: z.number().int().min(1).max(MAX_STALL_INT),
  /** `tool_loop`: repeats of the same tool with near-identical normalised arguments. */
  toolLoopRepeats: z.number().int().min(2).max(MAX_STALL_INT),
  /** `error_loop`: consecutive tool errors or denials of the same kind. */
  errorLoop: z.number().int().min(2).max(MAX_STALL_INT),
  /** `budget_crawl`: USD spent without a status change. */
  budgetDeltaUsd: z.number().positive().max(MAX_STALL_BUDGET_USD),
  /** `time_box`: minutes in one subtask without completion. */
  subtaskMaxMinutes: z.number().int().min(1).max(MAX_STALL_SUBTASK_MIN),
});
export type StallThresholds = z.output<typeof stallThresholdsSchema>;

/** A tenant- or persona-level override: any subset of the thresholds. */
export const stallThresholdsOverrideSchema = stallThresholdsSchema.partial();
export type StallThresholdsOverride = z.output<typeof stallThresholdsOverrideSchema>;

/** Persona name keys are the catalogue's kebab-case names (`exploit-developer`, `mentor`). */
const personaKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

/** Defaults of the five rules (MENTOR-001 #420). Overridden per deployment by env, never by the model. */
const STALL_DEFAULTS = {
  noProgressTurns: 6,
  toolLoopRepeats: 4,
  errorLoop: 3,
  budgetDeltaUsd: 0.5,
  subtaskMaxMinutes: 20,
} as const;

/** Env slice: one key per threshold, each defaulting to the value CONTEXT_PACK §4 and MENTOR-001 name. */
export const stallEnvShape = {
  STALL_NO_PROGRESS_TURNS: zStallInt(MAX_STALL_INT).default(STALL_DEFAULTS.noProgressTurns),
  STALL_TOOL_LOOP_REPEATS: zStallInt(MAX_STALL_INT).default(STALL_DEFAULTS.toolLoopRepeats),
  STALL_ERROR_LOOP: zStallInt(MAX_STALL_INT).default(STALL_DEFAULTS.errorLoop),
  STALL_BUDGET_DELTA_USD: zStallUsd(MAX_STALL_BUDGET_USD).default(STALL_DEFAULTS.budgetDeltaUsd),
  STALL_SUBTASK_MAX_MIN: zStallInt(MAX_STALL_SUBTASK_MIN).default(STALL_DEFAULTS.subtaskMaxMinutes),
  /** JSON object `{ "<persona>": { ...override } }`. Unset means no persona overrides. */
  STALL_PERSONA_OVERRIDES: z
    .string()
    .max(MAX_OVERRIDES_TEXT_LENGTH)
    .transform((raw, ctx): Record<string, StallThresholdsOverride> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', ...ISSUE_JSON });
        return z.NEVER;
      }
      const overrides = z.record(personaKeySchema, stallThresholdsOverrideSchema).safeParse(parsed);
      if (!overrides.success) {
        ctx.addIssue({ code: 'custom', message: 'must map persona names to valid thresholds' });
        return z.NEVER;
      }
      return overrides.data;
    })
    .default({}),
} as const;
export const stallEnvSchema = z.object(stallEnvShape);
export type StallEnv = z.output<typeof stallEnvSchema>;

/**
 * Maps the loaded env slice to thresholds plus per-persona overrides. Keys are exactly the schema's, so a
 * new env key cannot silently go unread.
 */
export function stallConfigFromEnv(env: StallEnv): {
  readonly thresholds: StallThresholds;
  readonly personaOverrides: Readonly<Record<string, StallThresholdsOverride>>;
} {
  return {
    thresholds: stallThresholdsSchema.parse({
      noProgressTurns: env.STALL_NO_PROGRESS_TURNS,
      toolLoopRepeats: env.STALL_TOOL_LOOP_REPEATS,
      errorLoop: env.STALL_ERROR_LOOP,
      budgetDeltaUsd: env.STALL_BUDGET_DELTA_USD,
      subtaskMaxMinutes: env.STALL_SUBTASK_MAX_MIN,
    }),
    personaOverrides: env.STALL_PERSONA_OVERRIDES,
  };
}
