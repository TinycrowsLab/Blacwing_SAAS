import { createHash } from 'node:crypto';

import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import {
  brokerGate2ExceptionResponseSchema,
  brokerPdpDecisionSchema,
  type BrokerGate2ExceptionRequest,
  type BrokerGate2ExceptionResponse,
  type BrokerPdpDecision,
  type IntrusivenessClass,
  type PdpReason,
  GATE2_ACTION_SUMMARY_INPUT_MAX,
} from '@blackwing/contracts';

import { extractTargets } from './targets.js';

/**
 * The `PreToolUse` hook (RUNTIME-005, #467; RUNTIME-006, #468; CONTEXT_PACK §4.3, §8.1, §8.2, §8.3, §8.11). Every tool
 * call is evaluated by the Policy Decision Point through the Run Broker before it runs. An out-of-envelope call the
 * PDP answers with `exception` becomes a Gate 2 exception: a single call returns `defer` (the session suspends until a
 * human decides), and a call in a parallel batch returns `deny` with `batch_out_of_envelope_paused`, because `defer`
 * is ignored for batches. The hook never returns `allow` from the exception path. A Gate 2 exception that cannot be
 * recorded is a `deny`.
 *
 * Hooks run before permission modes, so a `deny` holds whatever the model or the permission mode says. Fail closed
 * everywhere: malformed input, unresolved targets, a broker error, a timeout, or a PDP that cannot answer each deny
 * with a stable reason. The hook never throws into the SDK, so a bad call cannot crash the session.
 */

/** The decision the hook returns to the SDK. `defer` suspends the session until Gate 2 decides (§4.3). */
type HookDecisionValue = 'allow' | 'deny' | 'defer';

interface PreToolUseDecision {
  readonly decision: HookDecisionValue;
  readonly reason: PdpReason;
}

/** The SDK output shape for a `PreToolUse` hook. */
export interface PreToolUseOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse';
    readonly permissionDecision: HookDecisionValue;
    readonly permissionDecisionReason: string;
  };
}

/** Per-call options of a broker `POST`: the `Idempotency-Key` a Gate 2 retry must repeat. */
interface PdpBrokerPostOptions {
  readonly idempotencyKey?: string;
}

/** The only broker calls the hook makes (the PDP and Gate 2). Scoped to the run by the broker client. */
export interface PdpBroker {
  post<T>(
    suffix: string,
    body: unknown,
    schema: z.ZodType<T>,
    options?: PdpBrokerPostOptions,
  ): Promise<T>;
}

interface PreToolUseMetrics {
  /** `agent_pretooluse_decisions_total{decision,reason}` */
  decided(labels: { readonly decision: string; readonly reason: string }): void;
  /** `agent_pdp_latency_ms` */
  latency(ms: number): void;
  /** `agent_gate2_defers_total`: one per single call deferred to Gate 2. */
  gate2Deferred(): void;
  /** `agent_gate2_batch_denies_total`: one per out-of-envelope call denied because it ran in a batch. */
  gate2BatchDenied(): void;
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
  readonly sessionId: string;
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

/**
 * A short proposal for the approver: the reason, the tool and its targets. The call's input is never sent, so no
 * secret in it can reach the Gate 2 row.
 */
function proposalSummary(toolName: string, targets: readonly string[], reason: PdpReason): string {
  return `${reason}: ${toolName} ${targets.join(' ')}`.slice(0, GATE2_ACTION_SUMMARY_INPUT_MAX);
}

/**
 * The Gate 2 `Idempotency-Key` of one call: a digest of the session and the tool use id, so a retry of the same
 * call repeats the key and the broker returns the existing exception (GATE2-002).
 */
function idempotencyKeyOf(sessionId: string, toolUseId: string): string {
  return createHash('sha256').update(`${sessionId}:${toolUseId}`).digest('hex');
}

/**
 * Turns an out-of-envelope call into a Gate 2 exception (RUNTIME-006). A call in a batch is denied without a
 * Gate 2 row, since `defer` cannot suspend a batch. Otherwise the exception is recorded first: if that fails, the
 * call is denied, so it is never left ambiguously pending. A `pending` exception defers the call. A stored
 * denial, timeout or supersede is a deny. An approval never runs the call in this path: resuming it belongs to
 * RUNTIME-014, so it is denied here.
 */
async function escalate(
  call: { readonly tool_name: string; readonly tool_use_id: string },
  targets: readonly string[],
  reason: PdpReason,
  intrusiveness: IntrusivenessClass | undefined,
  context: PreToolUseContext,
  ports: PreToolUsePorts,
  batched: () => boolean,
): Promise<PreToolUseDecision> {
  const toolName = call.tool_name.slice(0, LOG_TOOL_NAME_MAX);
  if (batched()) {
    ports.metrics.gate2BatchDenied();
    ports.log.info(
      {
        toolName,
        decision: 'deny',
        reason: 'batch_out_of_envelope_paused',
        sessionId: context.sessionId,
      },
      'tool.batch_denied',
    );
    return deny('batch_out_of_envelope_paused');
  }
  // The PDP always states the class of an exception. Without it the exception cannot be recorded: fail closed.
  if (intrusiveness === undefined) return deny('gate2_exception_unavailable');

  const body: BrokerGate2ExceptionRequest = {
    sessionId: context.sessionId,
    subtaskId: context.subtaskId,
    testCaseId: context.testCaseId,
    toolName: call.tool_name,
    proposedActionSummary: proposalSummary(call.tool_name, targets, reason),
    envelopeReason: reason,
    intrusiveness,
    batch: false,
  };
  let opened: BrokerGate2ExceptionResponse;
  try {
    opened = await withTimeout(
      ports.broker.post('gate2/exceptions', body, brokerGate2ExceptionResponseSchema, {
        idempotencyKey: idempotencyKeyOf(context.sessionId, call.tool_use_id),
      }),
      ports.timeoutMs,
    );
  } catch {
    return deny('gate2_exception_unavailable');
  }
  if (opened.state === 'pending') {
    ports.metrics.gate2Deferred();
    ports.log.info(
      {
        toolName,
        decision: 'defer',
        reason,
        exceptionId: opened.exceptionId,
        sessionId: context.sessionId,
      },
      'tool.deferred',
    );
    return { decision: 'defer', reason };
  }
  if (opened.state === 'approved_once') return deny('gate2_resume_required');
  return deny('gate2_denied');
}

/** Asks the PDP for one call. Every failure, including a malformed answer, is a deny. */
async function evaluate(
  raw: unknown,
  context: PreToolUseContext,
  ports: PreToolUsePorts,
  batched: () => boolean,
): Promise<PreToolUseDecision> {
  const parsed = hookInputSchema.safeParse(raw);
  if (!parsed.success) return deny('invalid_input');
  const call = parsed.data;
  const extracted = extractTargets(call.tool_name, call.tool_input);
  if (extracted.kind === 'unresolved') return deny('target_unresolved');

  const targets = [...extracted.targets];
  const body = {
    toolName: call.tool_name,
    toolUseId: call.tool_use_id,
    targets,
    subtaskId: context.subtaskId,
    testCaseId: context.testCaseId,
    roleId: context.roleId,
  };
  let answer: BrokerPdpDecision;
  try {
    answer = await withTimeout(
      ports.broker.post('pdp/evaluate', body, brokerPdpDecisionSchema),
      ports.timeoutMs,
    );
  } catch (error) {
    return deny(error instanceof PdpTimeoutError ? 'pdp_timeout' : 'pdp_unavailable');
  }
  if (answer.decision === 'exception') {
    return escalate(call, targets, answer.reason, answer.intrusiveness, context, ports, batched);
  }
  return { decision: answer.decision, reason: answer.reason };
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
 *
 * The hook payload carries no count of the calls in the turn, so a batch is detected from overlap: a call is batched
 * when another call of this session was still in flight while it was being decided. Parallel calls are dispatched
 * together, so they overlap. A lone call never overlaps and is never batched.
 */
export function createPreToolUseHook(
  ports: PreToolUsePorts,
  context: PreToolUseContext,
): (input: unknown) => Promise<PreToolUseOutput> {
  const tracer = trace.getTracer('@blackwing/agent-runtime');
  let inFlight = 0;
  let overlapped = false;
  const batched = (): boolean => overlapped;
  return (input) =>
    tracer.startActiveSpan('agent.pretooluse', async (span) => {
      const started = Date.now();
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      try {
        const decision = await evaluate(input, context, ports, batched);
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
        inFlight -= 1;
        if (inFlight === 0) overlapped = false;
        span.end();
      }
    });
}
