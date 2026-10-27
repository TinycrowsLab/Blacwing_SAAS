import { metrics } from '@opentelemetry/api';
import { defaultPayloadConverter, type Headers } from '@temporalio/common';

import {
  workflowContextToHeaderValues,
  type ContextRejectReason,
  type WorkflowContext,
} from '@blackwing/contracts/workflow-context';
import { AppError } from '@blackwing/errors';
import { findWorkflowContext } from '@blackwing/telemetry';

import type {
  WorkflowClientInterceptor,
  WorkflowQueryInput,
  WorkflowSignalInput,
  WorkflowSignalWithStartInput,
  WorkflowStartInput,
  WorkflowStartUpdateInput,
  WorkflowStartUpdateWithStartInput,
} from '@temporalio/client';

/** Test seam. Production code passes nothing: the ambient `runWithWorkflowContext` scope is used. */
export interface ContextClientInterceptorOptions {
  /** Where the context to propagate comes from. Default: the ALS scope of `@blackwing/telemetry`. */
  readonly source?: () => WorkflowContext | undefined;
}

const rejects = metrics
  .getMeter('@blackwing/workflow-shared')
  .createCounter('workflow_context_rejects_total', {
    description:
      'Durable-execution calls refused for a missing, invalid or mismatched tenant context',
  });

const REASON: ContextRejectReason = 'missing_tenant';

/** Stamps the `x-bw-*` headers (JSON payloads), replacing any caller-supplied value of the same name. */
function stamp(headers: Headers, context: WorkflowContext): Headers {
  const stamped: Headers = { ...headers };
  for (const [name, value] of Object.entries(workflowContextToHeaderValues(context))) {
    stamped[name] = defaultPayloadConverter.toPayload(value);
  }
  return stamped;
}

/**
 * Client-side outbound interceptor (#25, §8.6): every workflow start (`start` is adapted to
 * `startWithDetails` by the SDK), signal, signal-with-start, query and
 * update leaves with the tenant and trace context of the calling scope, so the worker can re-establish it.
 * With no ambient context the call fails closed with `MISSING_TENANT_CONTEXT` before anything is sent:
 * durable work must never start without a tenant (a platform workflow says `SYSTEM` explicitly).
 */
export function createContextClientInterceptor(
  options: ContextClientInterceptorOptions = {},
): WorkflowClientInterceptor {
  const source = options.source ?? findWorkflowContext;
  const current = (): WorkflowContext => {
    const context = source();
    if (context === undefined) {
      rejects.add(1, { reason: REASON });
      throw new AppError(
        'MISSING_TENANT_CONTEXT',
        'refusing to call Temporal without a tenant context: wrap the call in runWithWorkflowContext',
      );
    }
    return context;
  };
  return {
    startWithDetails: (input: WorkflowStartInput, next) =>
      next({ ...input, headers: stamp(input.headers, current()) }),
    signal: (input: WorkflowSignalInput, next) =>
      next({ ...input, headers: stamp(input.headers, current()) }),
    signalWithStart: (input: WorkflowSignalWithStartInput, next) =>
      next({ ...input, headers: stamp(input.headers, current()) }),
    query: (input: WorkflowQueryInput, next) =>
      next({ ...input, headers: stamp(input.headers, current()) }),
    startUpdate: (input: WorkflowStartUpdateInput, next) =>
      next({ ...input, headers: stamp(input.headers, current()) }),
    startUpdateWithStart: (input: WorkflowStartUpdateWithStartInput, next) => {
      const context = current();
      return next({
        ...input,
        workflowStartHeaders: stamp(input.workflowStartHeaders, context),
        updateHeaders: stamp(input.updateHeaders, context),
      });
    },
  };
}
