import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { trace } from '@opentelemetry/api';

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
  type AgentSessionDescriptor,
  type IntrusivenessClass,
  intrusivenessRank,
  parseIntrusivenessClass,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';
import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import type { RuntimeMetrics } from '../metrics.js';
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';

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

/*
 * The SDK options for one agent session (RUNTIME-002, #464; CONTEXT_PACK §4.3, §8.7, §8.11, §4.5).
 *
 * `buildOptions` is the single factory for the mandatory SDK options of a Blackwing session, derived from the
 * validated descriptor. Per-tool gating (`allowedTools`, `canUseTool`), output format, hooks and abort wiring
 * attach to the object it returns elsewhere. Every refusal fails closed with a stable `AppError` code and no
 * partial options are returned.
 */

/** Environment keys a session process may see. `env` is built from this list only, never from the host environment. */
export const MINIMAL_ENV_KEYS = [
  'PATH',
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
] as const;

/** Telemetry settings from config are admitted by namespace only; every other key is dropped. */
const OTEL_KEY = /^OTEL_[A-Z0-9_]+$/;
/** The sandbox's own PATH. The host PATH is never inherited. */
const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin';
const VIRTUAL_KEY_PREFIX = 'bwk_';
const SESSION_PERMISSION_MODE = 'default';
const TOOL_SERVER_PREFIX = /^mcp__(.+?)__/;

/** Tenant provider policy from the gateway or run manifest (§4.3). */
export interface ProviderPolicy {
  /** Set only when the tenant policy allows the fallback model. Anything else omits `fallbackModel`. */
  readonly allowFallbackModel: boolean;
  readonly fallbackModel?: string;
}

/** Runtime inputs that the descriptor does not carry. The caller loads them from config, never from the host env. */
export interface AgentOptionsConfig {
  /** Egress gateway proxy URL, without credentials. The session's proxy identity is its username. */
  readonly egressProxyUrl: string;
  /** Resolves the descriptor's `virtualKeyRef` to the `bwk_` virtual key. `undefined` (or a throw) fails closed. */
  readonly resolveVirtualKey: (virtualKeyRef: string) => string | undefined;
  /** `OTEL_*` settings. Absent means telemetry export is off, which is not an error. */
  readonly otelEnv?: Readonly<Record<string, string>>;
  readonly providerPolicy: ProviderPolicy;
  /** Remaining session budget in USD. The gateway is the primary budget enforcer; this is a secondary cap. */
  readonly budgetRemainingUsd?: number;
  /** In-process MCP servers keyed by the server name used in `EXPOSURE_MATRIX`. */
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly metrics?: RuntimeMetrics;
  /** Receives the audit facts of a built session. Carries no secret and no option values. */
  readonly onBuilt?: (event: AgentOptionsBuiltEvent) => void;
}

/** The `session.options_built` audit facts (§8.11). `optionsSha256` covers the non-secret option set only. */
export interface AgentOptionsBuiltEvent {
  readonly sessionId: string;
  readonly persona: string;
  readonly model: string;
  readonly effort: string;
  readonly maxTurns: number;
  readonly mcpServers: readonly string[];
  readonly optionsSha256: string;
}

/** The server name of an `mcp__<server>__<tool>` entry, or `undefined` for a built-in such as `Bash`. */
export function serverOfTool(tool: string): string | undefined {
  return TOOL_SERVER_PREFIX.exec(tool)?.[1];
}

/**
 * The distinct in-process servers a persona's `EXPOSURE_MATRIX` row names, sorted. Derived from the matrix, so
 * there is no second persona-to-server table. An unknown persona or an empty row fails closed; it never mounts all.
 */
export function mcpServerNamesFor(persona: string): readonly string[] {
  const rows: Readonly<Record<string, readonly string[]>> = EXPOSURE_MATRIX;
  const row = Object.hasOwn(rows, persona) ? rows[persona] : undefined;
  if (row === undefined || row.length === 0) {
    throw new AppError('AGENT_UNKNOWN_PERSONA', 'agent persona has no exposure row', {
      detail: 'persona is not in the exposure matrix',
    });
  }
  const names = new Set<string>();
  for (const tool of row) {
    const server = serverOfTool(tool);
    if (server !== undefined) names.add(server);
  }
  return [...names].sort();
}

/**
 * Throws `AGENT_FORBIDDEN_PERMISSION_MODE` for any mode other than `default`. A session may never bypass
 * permissions, and `dontAsk` and `auto` are refused as well (§4.5).
 */
export function assertPermissionMode(mode: string): 'default' {
  if (mode !== SESSION_PERMISSION_MODE) {
    throw new AppError('AGENT_FORBIDDEN_PERMISSION_MODE', 'agent permission mode must be default');
  }
  return SESSION_PERMISSION_MODE;
}

/** The session cap: the descriptor's budget, lowered to the remaining budget. Exhausted or invalid fails closed. */
function resolveSessionBudget(descriptorBudget: number, remaining: number | undefined): number {
  if (remaining === undefined) return descriptorBudget;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new AppError('AGENT_BUDGET_EXHAUSTED', 'agent session budget is exhausted');
  }
  return Math.min(descriptorBudget, remaining);
}

/** Resolves the virtual key. Missing, malformed or a throwing resolver fails closed; the key never reaches a log. */
function resolveVirtualKey(descriptor: AgentSessionDescriptor, config: AgentOptionsConfig): string {
  let key: string | undefined;
  try {
    key = config.resolveVirtualKey(descriptor.virtualKeyRef);
  } catch {
    key = undefined;
  }
  if (
    key === undefined ||
    !key.startsWith(VIRTUAL_KEY_PREFIX) ||
    key.length <= VIRTUAL_KEY_PREFIX.length
  ) {
    throw new AppError('AGENT_NO_VIRTUAL_KEY', 'agent virtual key is unavailable');
  }
  return key;
}

/** The egress proxy URL with the per-session identity as its username. A password in config is refused. */
function sessionProxyUrl(sessionId: string, egressProxyUrl: string): string {
  const url = new URL(egressProxyUrl);
  if (url.password !== '') {
    throw new AppError('CONFIG_INVALID', 'egress proxy URL must not carry a password');
  }
  url.username = sessionId;
  return url.toString();
}

/** Mounts exactly the named servers. A missing server fails closed; it is never silently dropped. */
function selectServers(
  names: readonly string[],
  registry: Readonly<Record<string, McpServerConfig>>,
): Record<string, McpServerConfig> {
  const mounted: Record<string, McpServerConfig> = {};
  for (const name of names) {
    const server = Object.hasOwn(registry, name) ? registry[name] : undefined;
    if (server === undefined) {
      throw new AppError(
        'AGENT_MCP_SERVER_MISSING',
        'a required agent MCP server is not provided',
        {
          detail: `missing server: ${name}`,
        },
      );
    }
    mounted[name] = server;
  }
  return mounted;
}

/** The minimal session environment. The SDK replaces the process env, so every key is listed here (§8.7). */
function buildEnv(
  descriptor: AgentSessionDescriptor,
  apiKey: string,
  proxyUrl: string,
  otelEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    PATH: SANDBOX_PATH,
    HOME: descriptor.workspaceDir,
    CLAUDE_CONFIG_DIR: join(descriptor.workspaceDir, '.claude'),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // Telemetry is on only when an OTEL endpoint is configured; without one it is off, not an error.
    CLAUDE_CODE_ENABLE_TELEMETRY: Object.keys(otelEnv).length > 0 ? '1' : '0',
    ANTHROPIC_BASE_URL: descriptor.modelGatewayBaseUrl,
    ANTHROPIC_API_KEY: apiKey,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NODE_EXTRA_CA_CERTS: descriptor.caBundlePath,
    SSL_CERT_FILE: descriptor.caBundlePath,
    REQUESTS_CA_BUNDLE: descriptor.caBundlePath,
    ...otelEnv,
  };
}

/** Admits only `OTEL_*` keys with a value. Everything else from config is dropped. */
function admittedOtelEnv(
  source: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const admitted: Record<string, string> = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (OTEL_KEY.test(key) && value !== '') admitted[key] = value;
  }
  return admitted;
}

/**
 * Builds the mandatory SDK options for one agent session from its validated descriptor (RUNTIME-002, #464).
 *
 * Settings are never loaded (`settingSources: []`), the environment is an explicit allowlist, the permission
 * mode is `default`, and the mounted MCP servers are exactly the ones the persona's exposure row names. The
 * refusals (unknown persona, exhausted budget, missing virtual key, missing server, forbidden mode) all throw
 * before the working directory is created, so a refused session leaves no trace.
 */
export function buildOptions(
  descriptor: AgentSessionDescriptor,
  config: AgentOptionsConfig,
): Options {
  const serverNames = mcpServerNamesFor(descriptor.persona);
  const maxBudgetUsd = resolveSessionBudget(descriptor.maxBudgetUsd, config.budgetRemainingUsd);
  const permissionMode = assertPermissionMode(SESSION_PERMISSION_MODE);
  const apiKey = resolveVirtualKey(descriptor, config);
  const mcpServers = selectServers(serverNames, config.mcpServers);
  const proxyUrl = sessionProxyUrl(descriptor.sessionId, config.egressProxyUrl);
  const otelEnv = admittedOtelEnv(config.otelEnv);
  const env = buildEnv(descriptor, apiKey, proxyUrl, otelEnv);
  const fallbackModel =
    config.providerPolicy.allowFallbackModel && config.providerPolicy.fallbackModel !== undefined
      ? config.providerPolicy.fallbackModel
      : undefined;
  const thinking = { type: 'adaptive' } as const;

  mkdirSync(descriptor.workspaceDir, { recursive: true });

  const options: Options = {
    settingSources: [],
    cwd: descriptor.workspaceDir,
    env,
    model: descriptor.model,
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
    effort: descriptor.effort,
    maxTurns: descriptor.maxTurns,
    maxBudgetUsd,
    permissionMode,
    includePartialMessages: true,
    thinking,
    mcpServers,
  };

  const optionsSha256 = createHash('sha256')
    .update(
      JSON.stringify({
        model: descriptor.model,
        fallbackModel: fallbackModel ?? null,
        effort: descriptor.effort,
        maxTurns: descriptor.maxTurns,
        maxBudgetUsd,
        cwd: descriptor.workspaceDir,
        permissionMode,
        thinking,
        includePartialMessages: true,
        mcpServers: serverNames,
        envKeys: Object.keys(env).sort(),
      }),
    )
    .digest('hex');

  trace.getActiveSpan()?.setAttributes({
    'agent.model': descriptor.model,
    'agent.effort': descriptor.effort,
    'agent.mcp_servers': serverNames.join(','),
  });
  config.metrics?.optionsBuilt.inc({ persona: descriptor.persona });
  config.onBuilt?.({
    sessionId: descriptor.sessionId,
    persona: descriptor.persona,
    model: descriptor.model,
    effort: descriptor.effort,
    maxTurns: descriptor.maxTurns,
    mcpServers: serverNames,
    optionsSha256,
  });
  return options;
}
