import {
  composePrompt,
  loadPrompt,
  PersonaError,
  resolveTier,
  type EffortLevel,
  type EvalFlags,
  type ModelProvider,
  type PersonaDefinition,
  type RunContext,
} from '@blackwing/agents';
import {
  type IntrusivenessClass,
  intrusivenessRank,
  parseIntrusivenessClass,
} from '@blackwing/contracts';

/**
 * Claude Agent SDK session options for one specialist session (REGISTRY-004, REGISTRY-005, CONTEXT_PACK §4.2,
 * §4.6, §8.9 and §8.11).
 *
 * A persona is data. This module turns the persona, the signed run context and the pinned provider into the
 * options a session starts with: the tier-pinned model, the composed system prompt (with the authorisation
 * block), the step and budget ceilings, the effective intrusiveness ceiling, and a deny-by-default `canUseTool`
 * gate. Settings are never loaded from the sandbox (`settingSources: []`) and permissions are never bypassed.
 *
 * The SDK's own types are not imported here, so the runtime's dependency surface stays unchanged. The shape
 * below is structural and matches the SDK's options and `canUseTool` contract.
 */

/** A `canUseTool` decision, shaped like the SDK's permission result. */
type ToolDecision =
  | { readonly behavior: 'allow'; readonly updatedInput: Readonly<Record<string, unknown>> }
  | { readonly behavior: 'deny'; readonly message: string };

/** Per-call permission gate. Denies anything the persona did not declare (deny by default). */
export type CanUseTool = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
) => Promise<ToolDecision>;

export interface SessionOptions {
  readonly model: string;
  readonly effort: EffortLevel;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly systemPrompt: string;
  /** SHA-256 (hex) of the composed system prompt, pinned per session (§8.9). */
  readonly composedSha256: string;
  /** SHA-256 of the persona prompt body (REGISTRY-002). */
  readonly promptSha256: string;
  /** Effective ceiling: the lower of the run's `maxIntrusiveness` and the persona's ceiling. */
  readonly intrusivenessCeiling: IntrusivenessClass;
  readonly settingSources: readonly [];
  readonly permissionMode: 'default';
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly canUseTool: CanUseTool;
}

export interface SessionOptionsInput {
  readonly persona: PersonaDefinition;
  readonly runContext: RunContext;
  readonly provider: ModelProvider;
  readonly evalFlags?: EvalFlags;
  /** Remaining session budget in USD. Secondary to the model gateway's budget; it can only lower the cap. */
  readonly budgetRemainingUsd?: number;
  /** Bare model allowlist from the gateway. Omitted means the package default. */
  readonly allowlist?: readonly string[];
}

const BUDGET_INVALID = 'PERSONA_INVALID: remaining budget must be a positive finite number';
const WILDCARD_ONLY = '*';

/**
 * Matches a declared tool name. A pattern is either an exact name or a name with one trailing `*`
 * (for example `mcp__playwright__*`). The prefix keeps its `__` separator, so `mcp__playwright`
 * never matches `mcp__playwrightx__…`.
 */
function matchesDeclared(pattern: string, toolName: string): boolean {
  return pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : pattern === toolName;
}

/** Rejects a pattern that would allow every tool. Persona data is never trusted to do that. */
function assertNoCatchAll(patterns: readonly string[]): void {
  if (patterns.includes(WILDCARD_ONLY)) {
    throw new PersonaError(
      'PERSONA_FORBIDDEN_TOOL',
      'PERSONA_FORBIDDEN_TOOL: catch-all tool pattern',
    );
  }
}

/**
 * Builds the deny-by-default permission gate. A call is allowed only when it matches a declared
 * allowed pattern and no disallowed pattern. Every other call, including unknown names, is denied.
 */
export function createCanUseTool(
  allowedTools: readonly string[],
  disallowedTools: readonly string[],
): CanUseTool {
  assertNoCatchAll(allowedTools);
  return (toolName, input) => {
    if (disallowedTools.some((p) => matchesDeclared(p, toolName))) {
      return Promise.resolve({ behavior: 'deny', message: `tool ${toolName} is disallowed` });
    }
    if (allowedTools.some((p) => matchesDeclared(p, toolName))) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    return Promise.resolve({ behavior: 'deny', message: `tool ${toolName} is not declared` });
  };
}

/** The session budget: the persona default, lowered to the remaining budget when that is smaller. */
function resolveBudget(persona: PersonaDefinition, remaining: number | undefined): number {
  const cap = persona.maxBudgetUsdDefault;
  if (remaining === undefined) return cap;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new PersonaError('PERSONA_INVALID', BUDGET_INVALID);
  }
  return Math.min(cap, remaining);
}

/**
 * Assembles the Claude Agent SDK options for one persona session. Fails closed: an unknown provider or
 * model, a bad run context (missing authorisation fields), a released-prompt mismatch, an oversized
 * system prompt or a non-positive budget throws, and no partial options are returned.
 */
export function buildSessionOptions(input: SessionOptionsInput): SessionOptions {
  const { persona, runContext } = input;
  const prompt = loadPrompt(persona.promptRef.persona, persona.promptRef.version);
  const composed = composePrompt(prompt, runContext, {
    preamble: loadPrompt('_base').body,
  });

  const runCeiling = parseIntrusivenessClass(runContext.maxIntrusiveness);
  const intrusivenessCeiling =
    intrusivenessRank(runCeiling) <= intrusivenessRank(persona.intrusivenessCeiling)
      ? runCeiling
      : parseIntrusivenessClass(persona.intrusivenessCeiling);

  const model = resolveTier(persona.tierAlias, input.provider, input.evalFlags, input.allowlist);

  return {
    model,
    effort: persona.effort,
    maxTurns: persona.maxTurns,
    maxBudgetUsd: resolveBudget(persona, input.budgetRemainingUsd),
    systemPrompt: composed.systemPrompt,
    composedSha256: composed.composedSha256,
    promptSha256: composed.promptSha256,
    intrusivenessCeiling,
    settingSources: [],
    permissionMode: 'default',
    allowedTools: [...persona.allowedTools],
    disallowedTools: [...persona.disallowedTools],
    canUseTool: createCanUseTool(persona.allowedTools, persona.disallowedTools),
  };
}
