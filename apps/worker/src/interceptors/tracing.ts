import {
  context,
  metrics,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Context,
  type Span,
} from '@opentelemetry/api';

import type { ContextSinks, WorkflowSpanRecord } from './workflow.js';
import type { ContextRejectReason, WorkflowContext } from '@blackwing/contracts/workflow-context';
import type { Logger } from '@blackwing/logger';
import type { InjectedSinks } from '@temporalio/worker';

const tracer = trace.getTracer('@blackwing/worker');

/** Span id of the synthetic remote parent every Blackwing run span hangs off (the trace id is what matters). */
const REMOTE_PARENT_SPAN_ID = '0000000000000001';

const rejects = metrics
  .getMeter('@blackwing/worker')
  .createCounter('workflow_context_rejects_total', {
    description:
      'Durable-execution calls refused for a missing, invalid or mismatched tenant context',
  });

/** Counts one refusal. `reason` is the metric label (`missing_tenant`, `invalid_tenant`, `tenant_mismatch`). */
export function countContextReject(reason: ContextRejectReason): void {
  rejects.add(1, { reason });
}

/**
 * An OpenTelemetry context whose active span is a sampled remote parent with `traceId`. Spans started
 * under it (one per workflow run, one per activity attempt) all share that trace id, which is how a run's
 * workflow and activities end up in one trace.
 */
function traceParent(traceId: string): Context {
  return trace.setSpanContext(context.active(), {
    traceId,
    spanId: REMOTE_PARENT_SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

/** Span attributes for a Blackwing context (§8.6: the tenant id only, never tenant data). */
function contextAttributes(ctx: WorkflowContext): Record<string, string> {
  return {
    'bw.tenant_id': ctx.tenantId,
    ...(ctx.runId === undefined ? {} : { 'bw.run_id': ctx.runId }),
  };
}

/** Starts a span under the trace of `ctx`. The caller ends it. */
export function startContextSpan(
  name: string,
  ctx: WorkflowContext,
  attributes: Record<string, string | number> = {},
): { readonly span: Span; readonly otelContext: Context } {
  const parent = traceParent(ctx.traceId);
  const span = tracer.startSpan(
    name,
    { attributes: { ...contextAttributes(ctx), ...attributes } },
    parent,
  );
  return { span, otelContext: trace.setSpan(parent, span) };
}

/**
 * Worker-side implementation of the workflow sinks. A workflow cannot make network calls or create spans
 * in its sandbox, so it reports finished runs and refusals here. Sinks are skipped during replay, so a
 * replayed history never produces a duplicate span or count.
 */
export function createContextSinks(log: Logger): InjectedSinks<ContextSinks> {
  return {
    bwContext: {
      recordSpan: {
        fn(info, record: WorkflowSpanRecord) {
          const parent = traceParent(record.traceId);
          const span = tracer.startSpan(
            record.name,
            {
              startTime: record.startMs,
              attributes: {
                'bw.tenant_id': record.tenantId,
                ...(record.runId === undefined ? {} : { 'bw.run_id': record.runId }),
                'temporal.workflow.type': info.workflowType,
                'temporal.workflow.id': info.workflowId,
              },
            },
            parent,
          );
          if (record.failed) span.setStatus({ code: SpanStatusCode.ERROR });
          span.end(record.endMs);
        },
      },
      recordReject: {
        fn(info, reason, code) {
          countContextReject(reason);
          log.warn(
            { workflowType: info.workflowType, workflowId: info.workflowId, reason, code },
            'workflow context refused',
          );
        },
      },
    },
  };
}
