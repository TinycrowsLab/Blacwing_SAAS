import {
  AGENT_SESSION_RECORD_SUFFIX,
  agentSessionRecordSchema,
  type AgentSessionDescriptor,
  brokerStateResponseSchema,
} from '@blackwing/contracts';

import { ALWAYS_DISALLOWED, buildToolGate, denialReason } from './tool-gate.js';

import type { RuntimeMetrics } from '../metrics.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { BrokerClient } from '@blackwing/mcp-tools';

/**
 * The top-level session runner (RUNTIME-001, #463; CONTEXT_PACK §4.1, §4.4).
 *
 * `runSession` checks the run broker before any model call (fail closed: no broker, no traffic), builds the
 * SDK options from the descriptor, drives one `query()` to its result, and records the finished session with
 * one broker call. Every failure is a `SessionExit` that carries the process exit code, so the entry point
 * stays a thin mapper.
 */

/** Process exit codes of the runtime (RUNTIME-001). */
export const EXIT_CODES = {
  success: 0,
  descriptorInvalid: 2,
  /** The run broker is unreachable, refused the token, or the run is not active. Fail closed. */
  brokerUnavailable: 3,
  /** The session errored, or ended without a result. */
  unhandledError: 4,
} as const;

/** A failure that ends the process with `exitCode`. Its message never carries a token or a brief. */
export class SessionExit extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SessionExit';
  }
}

/** The subset of an SDK result message the runner reads. The adapter in `sdk.ts` produces it. */
interface SessionResultMessage {
  readonly type: 'result';
  readonly subtype: string;
  readonly num_turns: number;
  readonly total_cost_usd: number;
  readonly modelUsage: Readonly<Record<string, unknown>>;
  /** The authoritative record of denied tool calls (RUNTIME-003). Names only; the call inputs are never read. */
  readonly permission_denials?: readonly { readonly tool_name: string }[];
}

/** One stream message from the SDK. Only results are kept; every other message is ignored here. */
export type SessionStreamMessage = SessionResultMessage | { readonly type: string };

/** Starts one SDK session and yields its messages. Injected so tests never call the real SDK. */
export type RunQuery = (input: {
  readonly prompt: string;
  readonly options: Options;
}) => AsyncIterable<SessionStreamMessage>;

export interface SessionLog {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface SessionPorts {
  /** Run-scoped broker client (`@blackwing/mcp-tools`): fails closed on any transport or auth error. */
  readonly broker: BrokerClient;
  readonly runQuery: RunQuery;
  /** Version of the pinned SDK, recorded with the session. */
  readonly sdkVersion: string;
  readonly log: SessionLog;
  readonly metrics: RuntimeMetrics;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly status: string;
  readonly numTurns: number;
  readonly totalCostUsd: number;
}

/**
 * Builds the SDK options from the descriptor. The persona's richer options belong to `session/options.ts`
 * (RUNTIME-002). The tool gate (allow and deny sets, always-denied networked built-ins, deny-by-default
 * `canUseTool`) comes from `tool-gate.ts` (RUNTIME-003). Settings are never loaded from the sandbox, and the
 * permission mode is never `bypassPermissions`.
 */
export function buildRunOptions(
  descriptor: AgentSessionDescriptor,
  abortController: AbortController,
): Options {
  const gate = buildToolGate(descriptor);
  return {
    model: descriptor.model,
    effort: descriptor.effort,
    maxTurns: descriptor.maxTurns,
    maxBudgetUsd: descriptor.maxBudgetUsd,
    cwd: descriptor.workspaceDir,
    settingSources: [],
    permissionMode: 'default',
    allowedTools: [...gate.allowedTools],
    disallowedTools: [...gate.disallowedTools],
    canUseTool: gate.canUseTool,
    abortController,
  };
}

/** Longest tool name written to the denial log. A model-chosen name is untrusted, so it is bounded. */
const DENIED_TOOL_LOG_MAX = 128;

/**
 * Records every tool call the SDK denied (RUNTIME-003, §8.11). Each denial is counted by persona, tool and reason,
 * and logged by name. The tool label is the exact name only when the descriptor declares it, so a model-chosen
 * name cannot create new metric series. Call inputs are never logged.
 */
function recordDenials(
  descriptor: AgentSessionDescriptor,
  denials: SessionResultMessage['permission_denials'],
  ports: SessionPorts,
): void {
  const declared = new Set(
    [...ALWAYS_DISALLOWED, ...descriptor.allowedTools, ...descriptor.disallowedTools].filter(
      (rule) => !rule.endsWith('*') && !rule.includes('('),
    ),
  );
  for (const denial of denials ?? []) {
    const reason = denialReason(denial.tool_name, descriptor.disallowedTools);
    const tool = declared.has(denial.tool_name) ? denial.tool_name : 'other';
    ports.metrics.toolDenied.inc({ persona: descriptor.persona, tool, reason });
    ports.log.info(
      {
        runId: descriptor.runId,
        sessionId: descriptor.sessionId,
        persona: descriptor.persona,
        tool: denial.tool_name.slice(0, DENIED_TOOL_LOG_MAX),
        reason,
      },
      'tool.denied',
    );
  }
}

/** Checks the run broker before any model call. Any failure, or an inactive run, fails closed (exit 3). */
async function assertBrokerReady(broker: BrokerClient): Promise<void> {
  let state: { readonly active: boolean };
  try {
    state = await broker.get('state', brokerStateResponseSchema);
  } catch {
    throw new SessionExit(EXIT_CODES.brokerUnavailable, 'run broker unavailable');
  }
  if (!state.active) {
    throw new SessionExit(EXIT_CODES.brokerUnavailable, 'run is not active');
  }
}

/** Drives the SDK session to its result. The last result message wins (it carries the running totals). */
async function drive(
  descriptor: AgentSessionDescriptor,
  runQuery: RunQuery,
  abortController: AbortController,
): Promise<SessionResultMessage> {
  let result: SessionResultMessage | undefined;
  try {
    const stream = runQuery({
      prompt: descriptor.brief,
      options: buildRunOptions(descriptor, abortController),
    });
    for await (const message of stream) {
      if (message.type === 'result' && isResult(message)) result = message;
    }
  } catch {
    throw new SessionExit(EXIT_CODES.unhandledError, 'agent session failed');
  }
  if (result === undefined) {
    throw new SessionExit(EXIT_CODES.unhandledError, 'agent session ended without a result');
  }
  return result;
}

function isResult(message: SessionStreamMessage): message is SessionResultMessage {
  return 'subtype' in message && typeof message.subtype === 'string';
}

/**
 * Runs one agent session end to end. Throws a `SessionExit` on any failure; resolves with the summary when the
 * session finished and its record was written.
 */
export async function runSession(
  descriptor: AgentSessionDescriptor,
  ports: SessionPorts,
): Promise<SessionSummary> {
  const started = {
    runId: descriptor.runId,
    sessionId: descriptor.sessionId,
    persona: descriptor.persona,
    model: descriptor.model,
  };
  ports.log.info(started, 'session.start_requested');

  await assertBrokerReady(ports.broker);

  ports.metrics.sessionsStarted.inc({ persona: descriptor.persona });
  const result = await drive(descriptor, ports.runQuery, new AbortController());
  recordDenials(descriptor, result.permission_denials, ports);
  const record = agentSessionRecordSchema.parse({
    sessionId: descriptor.sessionId,
    persona: descriptor.persona,
    personaVersion: descriptor.personaVersion,
    promptSha256: descriptor.promptSha256,
    model: descriptor.model,
    effort: descriptor.effort,
    sdkVersion: ports.sdkVersion,
    status: result.subtype,
    numTurns: result.num_turns,
    totalCostUsd: result.total_cost_usd,
    modelUsage: result.modelUsage,
  });

  try {
    await ports.broker.post(AGENT_SESSION_RECORD_SUFFIX, record);
  } catch {
    throw new SessionExit(EXIT_CODES.brokerUnavailable, 'could not record the agent session');
  }

  ports.log.info(
    { ...started, status: result.subtype, numTurns: result.num_turns },
    'session.recorded',
  );
  return {
    sessionId: descriptor.sessionId,
    status: result.subtype,
    numTurns: result.num_turns,
    totalCostUsd: result.total_cost_usd,
  };
}
