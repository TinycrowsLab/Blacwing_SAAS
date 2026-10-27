import { fileURLToPath } from 'node:url';

import { context, SpanStatusCode } from '@opentelemetry/api';
import { ApplicationFailure } from '@temporalio/workflow';

import { parseWorkflowContext } from '@blackwing/contracts/workflow-context';
import { createLogger, type Logger } from '@blackwing/logger';
import { runWithWorkflowContext } from '@blackwing/telemetry';
import { createContextClientInterceptor } from '@blackwing/workflow-shared';

import { decodeContextHeaders } from './headers.js';
import { countContextReject, createContextSinks, startContextSpan } from './tracing.js';

import type { ContextSinks } from './workflow.js';
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  InjectedSinks,
  WorkerInterceptors,
} from '@temporalio/worker';

/** Entry of the workflow interceptor module: pass to `bundleWorkflowCode({ workflowInterceptorModules })`. */
export const WORKFLOW_INTERCEPTOR_MODULE = fileURLToPath(new URL('./workflow.ts', import.meta.url));

const defaultLog = createLogger('worker').child({ component: 'context-interceptor' });

/**
 * Activity-side inbound interceptor (#25, §8.6). It reads the `x-bw-*` headers the workflow stamped,
 * fails closed (non-retryable `MISSING_TENANT_CONTEXT` / `INVALID_TENANT_CONTEXT`) when they are absent
 * or invalid, and runs the activity inside an AsyncLocalStorage scope so `getActivityContext()` returns
 * the right tenant. The scope is created per attempt, so concurrent activities of different tenants
 * never share it. The activity also runs inside a span of the run's trace.
 */
export function createContextActivityInterceptor(
  log: Logger = defaultLog,
): ActivityInterceptorsFactory {
  return (activityContext) => {
    const interceptor: ActivityInboundCallsInterceptor = {
      async execute(input: ActivityExecuteInput, next) {
        const { activityType, workflowExecution, attempt } = activityContext.info;
        const parsed = parseWorkflowContext(decodeContextHeaders(input.headers));
        if (!parsed.ok) {
          countContextReject(parsed.reason);
          log.error(
            { activityType, workflowId: workflowExecution.workflowId, reason: parsed.reason },
            'activity refused: no valid tenant context',
          );
          throw ApplicationFailure.nonRetryable(parsed.message, parsed.code);
        }
        const ctx = parsed.context;
        log.info(
          { tenantId: ctx.tenantId, runId: ctx.runId, traceId: ctx.traceId, activityType, attempt },
          'activity started',
        );
        const { span, otelContext } = startContextSpan(`bw.activity ${activityType}`, ctx, {
          'temporal.activity.type': activityType,
          'temporal.activity.attempt': attempt,
        });
        try {
          return await context.with(otelContext, () =>
            runWithWorkflowContext(ctx, () => next(input)),
          );
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    };
    return { inbound: interceptor };
  };
}

/** Everything `Worker.create` needs to run the context interceptors (other than the workflow bundle). */
export interface ContextWorkerOptions {
  readonly interceptors: WorkerInterceptors;
  readonly sinks: InjectedSinks<ContextSinks>;
}

/**
 * Worker options that wire tenant and trace propagation: the activity interceptor, the sinks the workflow
 * interceptors report to, and the worker's own client (used by activities) stamping the ambient context.
 * Workflow interceptors are not listed here: with a pre-built workflow bundle the SDK only takes them from
 * `bundleWorkflowCode({ workflowInterceptorModules: [WORKFLOW_INTERCEPTOR_MODULE] })`.
 */
export function createContextWorkerOptions(log: Logger = defaultLog): ContextWorkerOptions {
  return {
    interceptors: {
      activity: [createContextActivityInterceptor(log)],
      client: { workflow: [createContextClientInterceptor()] },
    },
    sinks: createContextSinks(log),
  };
}
