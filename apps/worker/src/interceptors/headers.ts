// Sandbox-safe (WORKFLOW context interceptors, #25): imported by the workflow interceptor module, which is
// bundled for the deterministic workflow sandbox. Only `@temporalio/workflow` and pure modules here.
import { ApplicationFailure, defaultPayloadConverter, type Headers } from '@temporalio/workflow';

import {
  workflowContextToHeaderValues,
  WORKFLOW_CONTEXT_HEADERS,
  type ContextRefusal,
  type WorkflowContext,
} from '@blackwing/contracts/workflow-context';

/** Stands in for a header whose payload could not be decoded: it never validates, so it is refused as invalid. */
const UNDECODABLE: unique symbol = Symbol('undecodable-header');

/**
 * Decodes the `x-bw-*` headers into plain values for `parseWorkflowContext`. Context is derived only from
 * the headers in the event history (never from wall state), which keeps replay deterministic.
 */
export function decodeContextHeaders(headers: Headers): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const name of Object.values(WORKFLOW_CONTEXT_HEADERS)) {
    const payload = headers[name];
    if (payload === undefined) continue;
    try {
      decoded[name] = defaultPayloadConverter.fromPayload(payload);
    } catch {
      decoded[name] = UNDECODABLE;
    }
  }
  return decoded;
}

/** `headers` plus the context, each value a JSON payload. Replaces any existing `x-bw-*` header. */
export function stampContextHeaders(headers: Headers, context: WorkflowContext): Headers {
  const stamped: Headers = { ...headers };
  for (const [name, value] of Object.entries(workflowContextToHeaderValues(context))) {
    stamped[name] = defaultPayloadConverter.toPayload(value);
  }
  return stamped;
}

/**
 * The failure a refused context becomes. Non-retryable: retrying cannot create a tenant, and a plain
 * `Error` thrown from a workflow would only fail the workflow task in a loop. The `type` is the stable
 * `AppError` code, which survives the trip to the caller.
 */
export function contextFailure(refusal: ContextRefusal): ApplicationFailure {
  return ApplicationFailure.nonRetryable(refusal.message, refusal.code);
}
