import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import { isSpanContextValid, trace } from '@opentelemetry/api';

import {
  parseWorkflowContext,
  WORKFLOW_CONTEXT_HEADERS,
  type WorkflowContext,
} from '@blackwing/contracts/workflow-context';
import { AppError } from '@blackwing/errors';

/** What a caller supplies to scope a block of work; the trace id is filled in when omitted. */
export interface WorkflowContextInit {
  /** A tenant UUID, or `SYSTEM` for platform workflows. */
  readonly tenantId: string;
  /** 32 lowercase hex characters. Default: the active OpenTelemetry trace, else a fresh one. */
  readonly traceId?: string | undefined;
  readonly runId?: string | undefined;
}

// One store per async chain (an activity attempt, or a request that starts workflows): two activities of
// different tenants running concurrently on one worker never see each other's context.
const storage = new AsyncLocalStorage<WorkflowContext>();

/** Bytes in a W3C trace id (32 hex characters). */
const TRACE_ID_BYTES = 16;

function newTraceId(): string {
  // All-zero bytes happen with probability 2^-128; the loop keeps the id valid regardless.
  for (;;) {
    const id = randomBytes(TRACE_ID_BYTES).toString('hex');
    if (/[1-9a-f]/.test(id)) return id;
  }
}

function activeTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext !== undefined && isSpanContextValid(spanContext)
    ? spanContext.traceId
    : undefined;
}

/**
 * Validates `init` and fills in the trace id. Throws `MISSING_TENANT_CONTEXT` / `INVALID_TENANT_CONTEXT`
 * (fail closed) rather than ever producing a context without a valid tenant.
 */
export function createWorkflowContext(init: WorkflowContextInit): WorkflowContext {
  const parsed = parseWorkflowContext({
    [WORKFLOW_CONTEXT_HEADERS.tenantId]: init.tenantId,
    [WORKFLOW_CONTEXT_HEADERS.traceId]: init.traceId ?? activeTraceId() ?? newTraceId(),
    [WORKFLOW_CONTEXT_HEADERS.runId]: init.runId,
  });
  if (!parsed.ok) throw new AppError(parsed.code, parsed.message);
  return parsed.context;
}

/**
 * Runs `fn` (and everything it awaits) under a validated context. The Temporal client interceptor reads
 * it to stamp `x-bw-*` headers on workflow starts, signals and queries, and the worker's activity
 * interceptor sets it for each activity attempt.
 */
export function runWithWorkflowContext<T>(init: WorkflowContextInit, fn: () => T): T {
  return storage.run(createWorkflowContext(init), fn);
}

/** The ambient context, or `undefined` outside {@link runWithWorkflowContext}. */
export function findWorkflowContext(): WorkflowContext | undefined {
  return storage.getStore();
}

/**
 * The context of the current activity attempt (or of the code that is starting workflows). Fails closed
 * with `MISSING_TENANT_CONTEXT` when there is none, so tenant-scoped code never runs unscoped (§8.6).
 */
export function getActivityContext(): WorkflowContext {
  const context = storage.getStore();
  if (context === undefined) {
    throw new AppError('MISSING_TENANT_CONTEXT', 'no workflow context is active on this call path');
  }
  return context;
}
