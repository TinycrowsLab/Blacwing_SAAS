// Pure types shared by the activity-side audit interceptor and the workflow-sandbox interceptor.
// Imported from the workflow bundle: no Node built-ins and no I/O here.

/** Name of the local activity through which workflow code asks the worker to write an audit intent. */
export const WORKFLOW_AUDIT_ACTIVITY = 'auditWorkflowEvent';

export type WorkflowAuditKind =
  'started' | 'completed' | 'failed' | 'cancelled' | 'continued_as_new';

/** Input of {@link WORKFLOW_AUDIT_ACTIVITY}. `runId` first-property convention feeds the tenant interceptor. */
export interface WorkflowAuditEvent {
  readonly runId: string;
  readonly kind: WorkflowAuditKind;
  readonly workflowType: string;
  readonly workflowId: string;
  /** Temporal's run id of this execution; distinguishes executions chained by continue-as-new. */
  readonly executionRunId: string;
  readonly errorCode?: string;
}

const CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_CAUSE_DEPTH = 8;

/**
 * A stable, bounded, non-secret code for a thrown value: the innermost `code` or Temporal failure `type`
 * along the cause chain, else the outermost error name. Never the message or the stack.
 */
export function auditErrorCode(error: unknown): string {
  let found: string | undefined;
  let name: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) break;
    const candidate = current as {
      code?: unknown;
      type?: unknown;
      name?: unknown;
      cause?: unknown;
    };
    for (const value of [candidate.code, candidate.type]) {
      if (typeof value === 'string' && CODE_PATTERN.test(value)) found = value;
    }
    if (
      name === undefined &&
      typeof candidate.name === 'string' &&
      CODE_PATTERN.test(candidate.name)
    ) {
      name = candidate.name;
    }
    current = candidate.cause;
  }
  return found ?? name ?? 'UNKNOWN';
}

/** True when the thrown value, or anything in its cause chain, is a Temporal cancellation. */
export function isCancelledError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const { name, cause } = current as { name?: unknown; cause?: unknown };
    if (name === 'CancelledFailure') return true;
    current = cause;
  }
  return false;
}
