import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { SpanStatusCode, trace } from '@opentelemetry/api';

import {
  type ToolErrorCode,
  ToolError,
  type ToolFailure,
  type ToolResult,
  toolFailure,
} from './errors.js';
import { DEFAULT_TOOL_OUTPUT_MAX_BYTES } from './limits.js';
import { summariseInput } from './summary.js';
import { type EvidenceSink, limitOutput } from './truncate.js';

import type { BrokerClient } from './broker-client.js';
import type { ToolMetrics } from './metrics.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

/** Tracer name; one `mcp.tool` span per call. */
const MCP_TOOL_TRACER = 'blackwing.mcp-tools';

/**
 * The fixed set of in-process MCP servers (CONTEXT_PACK §4.2). A tool belongs to exactly one; its surfaced
 * name is `mcp__<server>__<name>`. Which persona may call which is the exposure matrix (MCP-015).
 */
export const MCP_SERVERS = [
  'engagement',
  'evidence',
  'findings',
  'intel',
  'journal',
  'oob',
  'session',
  'target',
] as const;
export type McpServerName = (typeof MCP_SERVERS)[number];

const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
/** Claude API limit on a tool name. */
const QUALIFIED_NAME_MAX = 64;
const MS_PER_NS = 1e-6;

/** Who a session's tool calls are attributed to (§8.8). Fixed for the session; never taken from tool input. */
interface ToolIdentity {
  readonly subtaskId: string | null;
  readonly testCaseId: string | null;
  readonly roleId: string;
}

/** Everything a session's tools share. Built once by `apps/agent-runtime`. */
export interface ToolRuntime extends ToolIdentity {
  readonly broker: BrokerClient;
  readonly evidence: EvidenceSink;
  readonly metrics: ToolMetrics;
  /** Aborted by the kill switch. */
  readonly signal: AbortSignal;
  /** `BW_TOOL_OUTPUT_MAX_BYTES`, see `resolveOutputMaxBytes`. */
  readonly maxOutputBytes?: number;
  /** The per-run registry redactor (RUNTIME-007), applied on top of the built-in credential patterns. */
  readonly redact?: (text: string) => string;
}

/** What a handler receives besides its validated input. */
export interface ToolHandlerContext extends ToolIdentity {
  readonly broker: BrokerClient;
  readonly signal: AbortSignal;
}

export interface ToolSpec<In extends z.ZodObject, Out extends z.ZodType> {
  readonly server: McpServerName;
  /** snake_case, verb first, e.g. `get_engagement_state`. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: In;
  readonly outputSchema: Out;
  /** Mark every tool that changes nothing: the planner and the PDP rely on `readOnlyHint` (§4.2). */
  readonly readOnly: boolean;
  /** True when the tool reaches beyond the Blackwing backends (target interaction). */
  readonly openWorld?: boolean;
  readonly handler: (
    input: z.output<In>,
    context: ToolHandlerContext,
  ) => Promise<ToolResult<z.input<Out>>>;
}

export interface ToolDefinition {
  readonly server: McpServerName;
  readonly name: string;
  /** `mcp__<server>__<name>`. */
  readonly qualifiedName: string;
  readonly readOnly: boolean;
  /** Runs one call end to end (validate, handle, limit, audit) and never throws. */
  invoke(rawInput: unknown, runtime: ToolRuntime): Promise<CallToolResult>;
  /** The SDK tool, bound to a session's runtime. */
  bind(runtime: ToolRuntime): ReturnType<typeof tool>;
}

const envelope = (result: ToolResult<unknown>): string => JSON.stringify(result);

function failureOf(error: unknown, signal: AbortSignal): ToolFailure {
  if (error instanceof ToolError) return toolFailure(error.code, error.message);
  // The raw message may carry paths, tokens or response bodies: the model and the audit get a fixed text.
  if (signal.aborted) return toolFailure('TOOL_KILLED', 'the run was killed');
  return toolFailure('TOOL_BACKEND_UNAVAILABLE', 'the tool failed unexpectedly');
}

/** Rejects when `signal` aborts, so a kill ends the call even if the handler ignores the signal. */
function abortion(signal: AbortSignal): { promise: Promise<never>; stop: () => void } {
  let stop = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(new ToolError('TOOL_KILLED', 'the run was killed'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    stop = () => {
      signal.removeEventListener('abort', onAbort);
    };
  });
  promise.catch(() => undefined);
  return { promise, stop };
}

/**
 * Defines a Blackwing MCP tool over the SDK's `tool()` (REFERENCES §3.1). Input is validated here with the
 * full Zod object (refinements included), output with `outputSchema`; the handler only wraps the broker.
 */
export function defineTool<In extends z.ZodObject, Out extends z.ZodType>(
  spec: ToolSpec<In, Out>,
): ToolDefinition {
  const qualifiedName = `mcp__${spec.server}__${spec.name}`;
  if (!MCP_SERVERS.includes(spec.server)) throw new TypeError(`unknown MCP server: ${spec.server}`);
  if (!TOOL_NAME.test(spec.name) || qualifiedName.length > QUALIFIED_NAME_MAX) {
    throw new TypeError(`tool name must be snake_case and fit 64 characters: ${qualifiedName}`);
  }
  if (spec.description.trim() === '')
    throw new TypeError(`tool ${qualifiedName} needs a description`);
  const tracer = trace.getTracer(MCP_TOOL_TRACER);

  const run = async (raw: unknown, runtime: ToolRuntime): Promise<ToolResult<unknown>> => {
    const killed = (): boolean => runtime.signal.aborted;
    if (killed()) return toolFailure('TOOL_KILLED', 'the run was killed');
    const parsed = spec.inputSchema.safeParse(raw);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(input)');
      return toolFailure('TOOL_INVALID_INPUT', `Invalid input: ${[...new Set(fields)].join(', ')}`);
    }
    const kill = abortion(runtime.signal);
    try {
      const handled = await Promise.race([
        spec.handler(parsed.data, {
          broker: runtime.broker,
          signal: runtime.signal,
          subtaskId: runtime.subtaskId,
          testCaseId: runtime.testCaseId,
          roleId: runtime.roleId,
        }),
        kill.promise,
      ]);
      // A kill that lands as the handler finishes wins: nothing is reported as a success after it.
      if (killed()) return toolFailure('TOOL_KILLED', 'the run was killed');
      if (!handled.ok) {
        return toolFailure(handled.code, handled.message);
      }
      const output = spec.outputSchema.safeParse(handled.data);
      if (!output.success) {
        return toolFailure('TOOL_BACKEND_UNAVAILABLE', 'the tool produced an invalid result');
      }
      return { ok: true, data: output.data };
    } catch (error) {
      return failureOf(error, runtime.signal);
    } finally {
      kill.stop();
    }
  };

  const invoke = async (raw: unknown, runtime: ToolRuntime): Promise<CallToolResult> => {
    const labels = { server: spec.server, tool: spec.name };
    const span = tracer.startSpan('mcp.tool', {
      attributes: { 'mcp.server': spec.server, 'mcp.tool': spec.name },
    });
    const started = process.hrtime.bigint();
    let result = await run(raw, runtime);
    let text = envelope(result);
    let bytes = Buffer.byteLength(text, 'utf8');
    if (result.ok) {
      try {
        const limited = await limitOutput(
          text,
          runtime.maxOutputBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES,
          runtime.evidence,
          `Full output of ${qualifiedName}`,
        );
        if (limited.truncated) runtime.metrics.truncated.inc(labels);
        ({ text, bytes } = limited);
      } catch (error) {
        result = failureOf(error, runtime.signal);
        text = envelope(result);
      }
    }
    const durationMs = Math.round(Number(process.hrtime.bigint() - started) * MS_PER_NS);
    try {
      await runtime.broker.post('tool-audit', {
        toolName: qualifiedName,
        subtaskId: runtime.subtaskId,
        testCaseId: runtime.testCaseId,
        roleId: runtime.roleId,
        durationMs,
        outputBytes: bytes,
        outcome: result.ok ? 'success' : 'error',
        code: result.ok ? null : result.code,
        inputSummary: summariseInput(raw, runtime.redact ?? ((text: string) => text)),
      });
    } catch {
      // No audit event, no success (§8.8). A failure that is already an error keeps its own code.
      if (result.ok) {
        result = toolFailure('TOOL_BACKEND_UNAVAILABLE', 'the tool call could not be audited');
        text = envelope(result);
      }
    }
    const outcome: ToolErrorCode | 'ok' = result.ok ? 'ok' : result.code;
    runtime.metrics.calls.inc({ ...labels, result: outcome });
    runtime.metrics.latency.observe(labels, durationMs);
    if (!result.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: result.code });
    span.end();
    return { content: [{ type: 'text', text }], isError: !result.ok };
  };

  return {
    server: spec.server,
    name: spec.name,
    qualifiedName,
    readOnly: spec.readOnly,
    invoke,
    bind: (runtime) =>
      tool(spec.name, spec.description, spec.inputSchema.shape, (args) => invoke(args, runtime), {
        annotations: { readOnlyHint: spec.readOnly, openWorldHint: spec.openWorld ?? false },
      }),
  };
}

export interface CreateServerOptions {
  readonly runtime: ToolRuntime;
  readonly version?: string;
  readonly instructions?: string;
  /** Keep the tool schemas in the initial prompt instead of deferring them behind tool search. */
  readonly alwaysLoad?: boolean;
  /** Hard per-call wall clock in ms (the SDK ignores values below 1000). */
  readonly timeoutMs?: number;
}

/** Builds the in-process MCP server `server` from its tools, bound to one session's runtime. */
export function createServer(
  server: McpServerName,
  tools: readonly ToolDefinition[],
  options: CreateServerOptions,
): McpSdkServerConfigWithInstance {
  const seen = new Set<string>();
  for (const definition of tools) {
    if (definition.server !== server) {
      throw new TypeError(`${definition.qualifiedName} does not belong to server ${server}`);
    }
    if (seen.has(definition.name))
      throw new TypeError(`duplicate tool ${definition.qualifiedName}`);
    seen.add(definition.name);
  }
  return createSdkMcpServer({
    name: server,
    version: options.version ?? '1.0.0',
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    tools: tools.map((definition) => definition.bind(options.runtime)),
    ...(options.alwaysLoad === undefined ? {} : { alwaysLoad: options.alwaysLoad }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
}
