import { z } from 'zod';

/**
 * Durable-execution context (CONTEXT_PACK §7, §8.6): the tenant and trace identifiers that travel in
 * Temporal headers through every workflow start, child workflow, signal and activity call.
 *
 * Pure and dependency-free apart from Zod on purpose: the Temporal workflow sandbox bundles this module
 * (through the `@blackwing/contracts/workflow-context` entry, which skips the rest of the barrel), and the
 * client, the worker and the ALS helper in `@blackwing/telemetry` all agree on it here.
 */

/** Header names. Values are JSON payloads written with the SDK default payload converter. */
export const WORKFLOW_CONTEXT_HEADERS = {
  tenantId: 'x-bw-tenant-id',
  traceId: 'x-bw-trace-id',
  runId: 'x-bw-run-id',
} as const;

/**
 * Explicit tenant sentinel for platform (non-tenant) workflows. It is never a blank or absent tenant: a
 * system workflow says so in its headers, so a missing tenant is always a bug that fails closed.
 */
export const SYSTEM_TENANT = 'SYSTEM';

/** Longest `runId` accepted: Blackwing run ids are 30-odd characters; this bounds a hostile header. */
const RUN_ID_MAX = 128;

const tenantIdSchema = z.union([z.uuid(), z.literal(SYSTEM_TENANT)]);
/** W3C trace-context trace id: 32 lowercase hex characters, not all zero. */
const traceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'must be 32 lowercase hex characters')
  .refine((id) => /[1-9a-f]/.test(id), 'must not be all zero');
const runIdSchema = z.string().min(1).max(RUN_ID_MAX);

/** The context a workflow, an activity or a client call runs under. */
export const workflowContextSchema = z.strictObject({
  /** A tenant UUID, or {@link SYSTEM_TENANT} for platform workflows. */
  tenantId: tenantIdSchema,
  traceId: traceIdSchema,
  runId: runIdSchema.optional(),
});
export type WorkflowContext = z.infer<typeof workflowContextSchema>;

/** Why a context was refused; the value of the `workflow_context_rejects_total{reason}` label. */
export type ContextRejectReason = 'missing_tenant' | 'invalid_tenant' | 'tenant_mismatch';

/** Error codes of the context refusals (registered in `@blackwing/errors`). */
export type ContextErrorCode =
  'MISSING_TENANT_CONTEXT' | 'INVALID_TENANT_CONTEXT' | 'TENANT_CONTEXT_MISMATCH';

/** A refused context: the stable error code, its metric reason and a message safe to log. */
export interface ContextRefusal {
  readonly ok: false;
  readonly code: ContextErrorCode;
  readonly reason: ContextRejectReason;
  readonly message: string;
}

export type WorkflowContextParse =
  { readonly ok: true; readonly context: WorkflowContext } | ContextRefusal;

const REFUSALS = {
  MISSING_TENANT_CONTEXT: { reason: 'missing_tenant' },
  INVALID_TENANT_CONTEXT: { reason: 'invalid_tenant' },
  TENANT_CONTEXT_MISMATCH: { reason: 'tenant_mismatch' },
} as const satisfies Record<ContextErrorCode, { reason: ContextRejectReason }>;

/** Builds a {@link ContextRefusal}. Messages never contain header values (they are untrusted input). */
export function refuse(code: ContextErrorCode, message: string): ContextRefusal {
  return { ok: false, code, reason: REFUSALS[code].reason, message };
}

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * Validates the decoded `x-bw-*` header values. `raw` maps a header name to its decoded JSON value.
 * A missing, `null` or empty tenant is `MISSING_TENANT_CONTEXT`; anything else that is not a UUID or
 * `SYSTEM`, a bad trace id or a bad run id is `INVALID_TENANT_CONTEXT`. Fails closed: the caller must
 * not run any tenant-scoped work unless this returns `ok`.
 */
export function parseWorkflowContext(raw: Readonly<Record<string, unknown>>): WorkflowContextParse {
  const tenant = raw[WORKFLOW_CONTEXT_HEADERS.tenantId];
  if (isBlank(tenant)) {
    return refuse(
      'MISSING_TENANT_CONTEXT',
      `header ${WORKFLOW_CONTEXT_HEADERS.tenantId} is required`,
    );
  }
  const runId = raw[WORKFLOW_CONTEXT_HEADERS.runId];
  const parsed = workflowContextSchema.safeParse({
    tenantId: tenant,
    traceId: raw[WORKFLOW_CONTEXT_HEADERS.traceId],
    ...(isBlank(runId) ? {} : { runId }),
  });
  if (parsed.success) return { ok: true, context: parsed.data };
  // Only the field names are reported: header values are untrusted and may be sensitive.
  const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  return refuse(
    'INVALID_TENANT_CONTEXT',
    `invalid workflow context header(s): ${fields.join(', ')}`,
  );
}

/** The header map a context is sent as (plain values; the transport JSON-encodes each one). */
export function workflowContextToHeaderValues(context: WorkflowContext): Record<string, string> {
  return {
    [WORKFLOW_CONTEXT_HEADERS.tenantId]: context.tenantId,
    [WORKFLOW_CONTEXT_HEADERS.traceId]: context.traceId,
    ...(context.runId === undefined ? {} : { [WORKFLOW_CONTEXT_HEADERS.runId]: context.runId }),
  };
}

/**
 * Compares the tenant a message carries with the tenant of the running workflow. A different tenant is
 * a cross-tenant attempt (`TENANT_CONTEXT_MISMATCH`); an unparsable header is refused as in
 * {@link parseWorkflowContext}. Only the tenant is compared: trace and run ids may differ per caller.
 */
export function checkSameTenant(
  expected: WorkflowContext,
  raw: Readonly<Record<string, unknown>>,
): WorkflowContextParse {
  const parsed = parseWorkflowContext(raw);
  if (!parsed.ok) return parsed;
  if (parsed.context.tenantId !== expected.tenantId) {
    return refuse(
      'TENANT_CONTEXT_MISMATCH',
      'message carries a different tenant than the workflow',
    );
  }
  return parsed;
}
