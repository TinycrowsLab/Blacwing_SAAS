// Workflow-sandbox side of the audit interceptor (WORKFLOW-007). Bundled with the workflow code: import
// only `@temporalio/workflow` and pure modules here, never Node built-ins. Workflow code must not do I/O,
// so each lifecycle event is a local activity (`auditWorkflowEvent`) that writes the outbox intent.
import {
  ApplicationFailure,
  CancellationScope,
  ContinueAsNew,
  proxyLocalActivities,
  workflowInfo,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptors,
} from '@temporalio/workflow';

import {
  auditErrorCode,
  isCancelledError,
  WORKFLOW_AUDIT_ACTIVITY,
  type WorkflowAuditEvent,
  type WorkflowAuditKind,
} from './audit-shared.js';

type EmitWorkflowAudit = (event: WorkflowAuditEvent) => Promise<void>;

interface WorkflowIdentity {
  readonly workflowType: string;
  readonly workflowId: string;
  readonly executionRunId: string;
}

/** A workflow without a `runId` first argument has no tenant: refuse to run it rather than skip auditing. */
function runIdOf(args: readonly unknown[]): string {
  const [first] = args;
  const runId =
    typeof first === 'object' && first !== null ? (first as { runId?: unknown }).runId : undefined;
  if (typeof runId !== 'string' || runId === '') {
    throw ApplicationFailure.nonRetryable(
      'workflow input carries no runId',
      'TENANT_CONTEXT_MISSING',
    );
  }
  return runId;
}

/** Pure core, parameterised for tests; `emit` must survive workflow cancellation: emits started, then exactly one terminal event. */
export function createWorkflowAuditInterceptor(
  emit: EmitWorkflowAudit,
  identity: () => WorkflowIdentity,
): WorkflowInboundCallsInterceptor {
  return {
    async execute(input, next) {
      const runId = runIdOf(input.args);
      const record = (kind: WorkflowAuditKind, errorCode?: string): Promise<void> =>
        emit({ runId, kind, ...identity(), ...(errorCode === undefined ? {} : { errorCode }) });

      await record('started');
      let result: unknown;
      try {
        result = await next(input);
      } catch (error) {
        if (error instanceof ContinueAsNew) await record('continued_as_new');
        else if (isCancelledError(error)) await record('cancelled');
        else await record('failed', auditErrorCode(error));
        throw error;
      }
      await record('completed');
      return result;
    },
  };
}

/** Temporal workflow-module entry point: register this file in `interceptors.workflowModules`. */
export function interceptors(): WorkflowInterceptors {
  const { [WORKFLOW_AUDIT_ACTIVITY]: emit } = proxyLocalActivities<{
    [WORKFLOW_AUDIT_ACTIVITY]: EmitWorkflowAudit;
  }>({
    startToCloseTimeout: '30 seconds',
    retry: { initialInterval: '200 milliseconds', backoffCoefficient: 2, maximumAttempts: 8 },
  });
  return {
    inbound: [
      // Non-cancellable so the terminal event still lands when the workflow itself was cancelled.
      createWorkflowAuditInterceptor(
        (event) => CancellationScope.nonCancellable(() => emit(event)),
        () => {
          const { workflowType, workflowId, runId } = workflowInfo();
          return { workflowType, workflowId, executionRunId: runId };
        },
      ),
    ],
  };
}
