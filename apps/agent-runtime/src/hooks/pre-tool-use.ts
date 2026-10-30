import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import {
  brokerPdpDecisionSchema,
  type BrokerPdpDecision,
  type PdpReason,
} from '@blackwing/contracts';

import { extractTargets } from './targets.js';

/**
 * The `PreToolUse` hook (RUNTIME-005, #467; CONTEXT_PACK §4.3, §8.1, §8.2, §8.3, §8.11). Every tool call is
 * evaluated by the Policy Decision Point through the Run Broker before it runs. The hook returns `allow` or `deny`
 * and never anything else: `defer` (Gate 2) is RUNTIME-006.
 *
 * Hooks run before permission modes, so a `deny` holds whatever the model or the permission mode says. Fail closed
 * everywhere: malformed input, unresolved targets, a broker error, a timeout, or a PDP that cannot answer each deny
 * with a stable reason. The hook never throws into the SDK, so a bad call cannot crash the session.
 */

/** The decision the hook returns to the SDK. */
interface PreToolUseDecision {
  readonly decision: 'allow' | 'deny';
  readonly reason: PdpReason;
}

/** The SDK output shape for a `PreToolUse` hook. */
export interface PreToolUseOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse';
    readonly permissionDecision: 'allow' | 'deny';
    readonly permissionDecisionReason: string;
  };
}

/** The only broker call the hook makes. Scoped to the run by the broker client. */
export interface PdpBroker {
  post<T>(suffix: string, body: unknown, schema: z.ZodType<T>): Promise<T>;
}

interface PreToolUseMetrics {
  /** `agent_pretooluse_decisions_total{decision,reason}` */
  decided(labels: { readonly decision: string; readonly reason: string }): void;
  /** `agent_pdp_latency_ms` */
  latency(ms: number): void;
}

interface PreToolUseLog {
  info(fields: Readonly<Record<string, string>>, message: string): void;
}

export interface PreToolUsePorts {
  readonly broker: PdpBroker;
  /** Bounded wait for the PDP. Exceeding it denies with `pdp_timeout`. */
  readonly timeoutMs: number;
  readonly metrics: PreToolUseMetrics;
  readonly log: PreToolUseLog;
}

/** The session facts a PDP call carries. The subtask, test case and role are null outside a test case. */
export interface PreToolUseContext {
  readonly subtaskId: string | null;
  readonly testCaseId: string | null;
  readonly roleId: string | null;
}

/** Longest tool name or tool-use id the hook accepts; a model-chosen value is bounded. */
const NAME_MAX = 256;
/** Longest tool name written to the log. */
const LOG_TOOL_NAME_MAX = 128;

const hookInputSchema = z.object({
  hook_event_name: z.literal('PreToolUse'),
  tool_name: z.string().min(1).max(NAME_MAX),
  tool_input: z.unknown(),
  tool_use_id: z.string().min(1).max(NAME_MAX),
});

/** Thrown by the timeout race. Only its class is read, so the message is fixed. */
class PdpTimeoutError extends Error {
  constructor() {
    super('pdp timed out');
    this.name = 'PdpTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new PdpTimeoutError());
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

const deny = (reason: PdpReason): PreToolUseDecision => ({ decision: 'deny', reason });

/** Asks the PDP for one call. Every failure, including a malformed answer, is a deny. */
async function evaluate(
  raw: unknown,
  context: PreToolUseContext,
  ports: PreToolUsePorts,
): Promise<PreToolUseDecision> {
  const parsed = hookInputSchema.safeParse(raw);
  if (!parsed.success) return deny('invalid_input');
  const call = parsed.data;
  const extracted = extractTargets(call.tool_name, call.tool_input);
  if (extracted.kind === 'unresolved') return deny('target_unresolved');

  const body = {
    toolName: call.tool_name,
    toolUseId: call.tool_use_id,
    targets: [...extracted.targets],
    subtaskId: context.subtaskId,
    testCaseId: context.testCaseId,
    roleId: context.roleId,
  };
  try {
    const answer: BrokerPdpDecision = await withTimeout(
      ports.broker.post('pdp/evaluate', body, brokerPdpDecisionSchema),
      ports.timeoutMs,
    );
    return { decision: answer.decision, reason: answer.reason };
  } catch (error) {
    return deny(error instanceof PdpTimeoutError ? 'pdp_timeout' : 'pdp_unavailable');
  }
}

/** The SDK output for one decision. */
function toHookOutput(decision: PreToolUseDecision): PreToolUseOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  };
}

/**
 * Builds the `PreToolUse` callback for one session. Each call is timed, counted by decision and reason, and traced
 * (`agent.pretooluse`). The log carries the tool name, decision and reason only, never the call's input.
 */
export function createPreToolUseHook(
  ports: PreToolUsePorts,
  context: PreToolUseContext,
): (input: unknown) => Promise<PreToolUseOutput> {
  const tracer = trace.getTracer('@blackwing/agent-runtime');
  return (input) =>
    tracer.startActiveSpan('agent.pretooluse', async (span) => {
      const started = Date.now();
      try {
        const decision = await evaluate(input, context, ports);
        ports.metrics.latency(Date.now() - started);
        ports.metrics.decided({ decision: decision.decision, reason: decision.reason });
        const toolName =
          typeof input === 'object' && input !== null && 'tool_name' in input
            ? String(input.tool_name).slice(0, LOG_TOOL_NAME_MAX)
            : 'unknown';
        ports.log.info(
          { toolName, decision: decision.decision, reason: decision.reason },
          'tool.pretooluse_decided',
        );
        return toHookOutput(decision);
      } finally {
        span.end();
      }
    });
}
