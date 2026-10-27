// Workflow interceptor module (#25). Temporal bundles this file into the deterministic workflow sandbox
// (`workflowInterceptorModules`): import only `@temporalio/workflow` and pure modules, never Node
// built-ins, the client, the logger or telemetry. Node-side work (spans, metrics) goes through sinks.
import {
  ContinueAsNew,
  proxySinks,
  workflowInfo,
  type ActivityInput,
  type ContinueAsNewInput,
  type LocalActivityInput,
  type QueryInput,
  type SignalInput,
  type SignalWorkflowInput,
  type Sinks,
  type StartChildWorkflowExecutionInput,
  type UpdateInput,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptors,
  type WorkflowInterceptorsFactory,
  type WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';

import {
  checkSameTenant,
  parseWorkflowContext,
  refuse,
  type ContextRefusal,
  type ContextRejectReason,
  type WorkflowContext,
} from '@blackwing/contracts/workflow-context';

import { contextFailure, decodeContextHeaders, stampContextHeaders } from './headers.js';

/** One finished workflow run, reported to the Node side so it becomes an OpenTelemetry span. */
export interface WorkflowSpanRecord {
  readonly name: string;
  readonly traceId: string;
  readonly tenantId: string;
  readonly runId?: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly failed: boolean;
}

/** Sinks the context interceptors call. Implemented in `tracing.ts`; they never run during replay. */
export interface ContextSinks extends Sinks {
  readonly bwContext: {
    recordSpan(span: WorkflowSpanRecord): void;
    recordReject(reason: ContextRejectReason, code: string): void;
  };
}

/** What the interceptors need from their surroundings (all faked in unit tests). */
export interface ContextInterceptorDeps {
  readonly recordSpan: (span: WorkflowSpanRecord) => void;
  readonly recordReject: (reason: ContextRejectReason, code: string) => void;
  readonly workflowType: () => string;
  readonly now: () => number;
}

/** Query names the SDK and Temporal UI send themselves (stack traces, metadata); they carry no headers. */
const isReservedQuery = (name: string): boolean => name.startsWith('__');

/**
 * Builds the inbound and outbound interceptors of one workflow instance. They share one piece of state,
 * the context read from the start headers; every later inbound message must agree with its tenant, and
 * every outbound call (activity, child workflow, signal, continue-as-new) re-injects it, so children and
 * activities inherit tenant and trace without the workflow code passing them.
 */
export function createWorkflowContextInterceptors(
  deps: ContextInterceptorDeps,
): WorkflowInterceptors {
  let running: WorkflowContext | undefined;

  const refuseAndRecord = (refusal: ContextRefusal): ContextRefusal => {
    deps.recordReject(refusal.reason, refusal.code);
    return refusal;
  };

  /** Checks a message against the running workflow's tenant; returns the refusal, or undefined when fine. */
  const checkMessage = (headers: WorkflowExecuteInput['headers']): ContextRefusal | undefined => {
    if (running === undefined) {
      return refuseAndRecord(refuse('MISSING_TENANT_CONTEXT', 'workflow has no tenant context'));
    }
    const checked = checkSameTenant(running, decodeContextHeaders(headers));
    return checked.ok ? undefined : refuseAndRecord(checked);
  };

  const requireRunning = (): WorkflowContext => {
    if (running === undefined) {
      throw contextFailure(
        refuseAndRecord(refuse('MISSING_TENANT_CONTEXT', 'workflow has no tenant context')),
      );
    }
    return running;
  };

  const inbound: WorkflowInboundCallsInterceptor = {
    async execute(input: WorkflowExecuteInput, next) {
      const parsed = parseWorkflowContext(decodeContextHeaders(input.headers));
      if (!parsed.ok) throw contextFailure(refuseAndRecord(parsed));
      running = parsed.context;
      const context = parsed.context;
      const startMs = deps.now();
      let failed = false;
      try {
        return await next(input);
      } catch (error) {
        // Continue-as-new is how a healthy long-running workflow ends one run.
        failed = !(error instanceof ContinueAsNew);
        throw error;
      } finally {
        deps.recordSpan({
          name: `bw.workflow ${deps.workflowType()}`,
          traceId: context.traceId,
          tenantId: context.tenantId,
          ...(context.runId === undefined ? {} : { runId: context.runId }),
          startMs,
          endMs: deps.now(),
          failed,
        });
      }
    },

    // A signal cannot be answered, and throwing here would let any sender of a forged signal fail the
    // victim workflow. A signal from another tenant (or without a tenant) is dropped and recorded.
    async handleSignal(input: SignalInput, next) {
      if (checkMessage(input.headers) !== undefined) return;
      await next(input);
    },

    // The refusal goes back to the caller of the query or update.
    async handleQuery(input: QueryInput, next) {
      if (!isReservedQuery(input.queryName)) {
        const refusal = checkMessage(input.headers);
        if (refusal !== undefined) throw contextFailure(refusal);
      }
      return await next(input);
    },
    validateUpdate(input: UpdateInput, next) {
      const refusal = checkMessage(input.headers);
      if (refusal !== undefined) throw contextFailure(refusal);
      next(input);
    },
    async handleUpdate(input: UpdateInput, next) {
      const refusal = checkMessage(input.headers);
      if (refusal !== undefined) throw contextFailure(refusal);
      return await next(input);
    },
  };

  const outbound: WorkflowOutboundCallsInterceptor = {
    scheduleActivity: (input: ActivityInput, next) =>
      next({ ...input, headers: stampContextHeaders(input.headers, requireRunning()) }),
    scheduleLocalActivity: (input: LocalActivityInput, next) =>
      next({ ...input, headers: stampContextHeaders(input.headers, requireRunning()) }),
    startChildWorkflowExecution: (input: StartChildWorkflowExecutionInput, next) =>
      next({ ...input, headers: stampContextHeaders(input.headers, requireRunning()) }),
    signalWorkflow: (input: SignalWorkflowInput, next) =>
      next({ ...input, headers: stampContextHeaders(input.headers, requireRunning()) }),
    continueAsNew: (input: ContinueAsNewInput, next) =>
      next({ ...input, headers: stampContextHeaders(input.headers, requireRunning()) }),
    getLogAttributes: (input, next) => {
      const attributes = next(input);
      if (running === undefined) return attributes;
      return {
        ...attributes,
        bw_tenant_id: running.tenantId,
        bw_trace_id: running.traceId,
        ...(running.runId === undefined ? {} : { bw_run_id: running.runId }),
      };
    },
  };

  return { inbound: [inbound], outbound: [outbound] };
}

/** The factory Temporal calls once per workflow instance. */
export const interceptors: WorkflowInterceptorsFactory = () => {
  const { bwContext } = proxySinks<ContextSinks>();
  return createWorkflowContextInterceptors({
    recordSpan: (span) => {
      bwContext.recordSpan(span);
    },
    recordReject: (reason, code) => {
      bwContext.recordReject(reason, code);
    },
    workflowType: () => workflowInfo().workflowType,
    now: () => Date.now(),
  });
};
