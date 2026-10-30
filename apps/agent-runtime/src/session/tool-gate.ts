import { FORBIDDEN_BUILTIN_TOOLS, PersonaError } from '@blackwing/agents';
import { AppError } from '@blackwing/errors';

/**
 * Static tool gating for one agent session (RUNTIME-003, #466; CONTEXT_PACK §4.3, §4.5, §8.11).
 *
 * This module is the single source of the session's tool allow and deny sets. It assembles `allowedTools` and
 * `disallowedTools` from the descriptor, adds the always-denied networked built-ins, and provides the
 * deny-by-default `canUseTool` gate. The dynamic per-request policy (the `PreToolUse` PDP hook, RUNTIME-005) runs
 * on top of this gate and is not implemented here.
 *
 * OSINT and intelligence work uses the Blackwing `intel_*` tools, which are routed through the egress gateway's
 * intelligence allowlist. It never uses the built-in web tools (`WebFetch`, `WebSearch`, `WebRequest`), because
 * those bypass or obscure the egress path.
 *
 * Rule syntax, matched exactly (tool names are case-sensitive):
 * - an exact name (`Read`, `mcp__server__tool`), or a name with one trailing `*` (`mcp__playwright__*`);
 * - a scoped form `Name(spec)` where `spec` is a glob with `*` (for example `Bash(rm *)`). A scoped deny applies
 *   when the call's primary argument matches the glob, or when the call has no primary argument to check. A
 *   scoped allow applies only when the primary argument matches.
 * - `Task` and `Agent` are the same tool for matching, so a subagent is gated under either name.
 *
 * `allowedTools` in the SDK only auto-approves. It does not restrict Claude, so `canUseTool` denies anything that
 * is not explicitly allowed, and a disallowed rule always wins over an allowed one.
 */

/** Networked built-ins that are always disallowed, whatever the persona or descriptor says (§4.3, §4.5). */
export const ALWAYS_DISALLOWED: readonly string[] = [...FORBIDDEN_BUILTIN_TOOLS, 'WebRequest'];

/** A `canUseTool` decision, shaped like the SDK's permission result. */
type ToolDecision =
  | { readonly behavior: 'allow'; readonly updatedInput: Readonly<Record<string, unknown>> }
  | { readonly behavior: 'deny'; readonly message: string };

/** Per-call permission gate. Denies anything the session did not declare (deny by default). */
export type CanUseTool = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
) => Promise<ToolDecision>;

/** The tool sets a session starts with. `canUseTool` enforces the same sets per call. */
export interface ToolGate {
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly canUseTool: CanUseTool;
}

/** Why a call was denied. Used as a metric label and in the denial log. */
type DenialReason = 'always_disallowed' | 'disallowed' | 'not_declared';

/** Argument keys that carry the primary target of a call, checked by scoped rules in this order. */
const PRIMARY_ARG_KEYS = ['command', 'file_path', 'path', 'url'] as const;
const WILDCARD_ONLY = '*';
const SCOPE_OPEN = '(';
/** The SDK names the subagent tool `Task` in some surfaces and `Agent` in others. */
const SUBAGENT_ALIASES: Readonly<Record<string, string>> = { Task: 'Agent' };

/** The canonical name of a tool for matching: the subagent alias is folded to one name. */
function canonicalName(name: string): string {
  return SUBAGENT_ALIASES[name] ?? name;
}

/** The rule without its `(spec)` scope, canonicalised: `Bash(rm *)` becomes `Bash`, `Task` becomes `Agent`. */
function ruleBase(rule: string): string {
  const open = rule.indexOf(SCOPE_OPEN);
  return canonicalName(open === -1 ? rule : rule.slice(0, open));
}

/** The scope of a `Name(spec)` rule, or `undefined` for an unscoped rule. */
function ruleScope(rule: string): string | undefined {
  const open = rule.indexOf(SCOPE_OPEN);
  if (open === -1 || !rule.endsWith(')')) return undefined;
  return rule.slice(open + 1, -1);
}

/**
 * Matches a declared tool name. A pattern is an exact name or a name with one trailing `*`. The prefix keeps its
 * `__` separator, so `mcp__playwright` never matches `mcp__playwrightx__…`.
 */
function matchesName(pattern: string, toolName: string): boolean {
  return pattern.endsWith(WILDCARD_ONLY)
    ? toolName.startsWith(pattern.slice(0, -1))
    : pattern === toolName;
}

/** Glob match of a scope spec (`*` is the only wildcard) against a primary argument. */
function globMatches(spec: string, value: string): boolean {
  const pattern = spec
    .split(WILDCARD_ONLY)
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`, 's').test(value);
}

/** The call's primary argument for a scoped rule, or `undefined` when the call has none. Leading space is ignored. */
function primaryArgument(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of PRIMARY_ARG_KEYS) {
    const value = input[key];
    if (typeof value === 'string') return value.trim();
  }
  return undefined;
}

/** Whether a rule applies to a call. Scoped deny rules fail closed when the call has no argument to check. */
function ruleApplies(
  rule: string,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  deny: boolean,
): boolean {
  const scope = ruleScope(rule);
  if (scope === undefined) return matchesName(ruleBase(rule), canonicalName(toolName));
  if (ruleBase(rule) !== canonicalName(toolName)) return false;
  const primary = primaryArgument(input);
  if (primary === undefined) return deny;
  return globMatches(scope, primary);
}

/** Rejects a pattern that would allow every tool. Persona or descriptor data is never trusted to do that. */
function assertNoCatchAll(patterns: readonly string[]): void {
  if (patterns.includes(WILDCARD_ONLY)) {
    throw new PersonaError(
      'PERSONA_FORBIDDEN_TOOL',
      'PERSONA_FORBIDDEN_TOOL: catch-all tool pattern',
    );
  }
}

/**
 * Builds the deny-by-default permission gate. A call is allowed only when an allowed rule applies and no disallowed
 * rule applies. Every other call, including unknown names, is denied with a reason.
 */
export function createCanUseTool(
  allowedTools: readonly string[],
  disallowedTools: readonly string[],
): CanUseTool {
  assertNoCatchAll(allowedTools);
  return (toolName, input) => {
    if (disallowedTools.some((rule) => ruleApplies(rule, toolName, input, true))) {
      return Promise.resolve({ behavior: 'deny', message: `tool ${toolName} is disallowed` });
    }
    if (allowedTools.some((rule) => ruleApplies(rule, toolName, input, false))) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    return Promise.resolve({ behavior: 'deny', message: `tool ${toolName} is not declared` });
  };
}

/**
 * Throws `AGENT_FORBIDDEN_TOOL` when an allowlist names a networked built-in, exactly or through a prefix such as
 * `Web*`, or inside a scoped rule such as `WebFetch(*)`. The check runs at build time, before any session starts.
 */
export function assertNoForbiddenAllow(input: { readonly allowedTools: readonly string[] }): void {
  for (const rule of input.allowedTools) {
    const base = ruleBase(rule);
    const hit = ALWAYS_DISALLOWED.find((name) => matchesName(base, name));
    if (hit !== undefined) {
      throw new AppError(
        'AGENT_FORBIDDEN_TOOL',
        'agent allowlist names a forbidden built-in tool',
        {
          detail: `forbidden built-in: ${hit}`,
        },
      );
    }
  }
}

/**
 * Assembles the tool gate for a session from its descriptor's allow and deny lists. The always-denied built-ins are
 * added to the disallowed set. A forbidden allow throws before any gate is returned, so no partial gate exists.
 */
export function buildToolGate(input: {
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
}): ToolGate {
  assertNoForbiddenAllow(input);
  const allowedTools = [...input.allowedTools];
  const disallowedTools = [...new Set([...input.disallowedTools, ...ALWAYS_DISALLOWED])];
  return {
    allowedTools,
    disallowedTools,
    canUseTool: createCanUseTool(allowedTools, disallowedTools),
  };
}

/**
 * Classifies a denied call for the metric and the denial log, from the tool name and the session's disallowed rules.
 * A scoped rule is classified by its tool name, so `Bash(rm *)` counts as a disallowed `Bash`.
 */
export function denialReason(toolName: string, disallowedTools: readonly string[]): DenialReason {
  const name = canonicalName(toolName);
  if (ALWAYS_DISALLOWED.some((rule) => matchesName(ruleBase(rule), name)))
    return 'always_disallowed';
  if (disallowedTools.some((rule) => matchesName(ruleBase(rule), name))) return 'disallowed';
  return 'not_declared';
}
