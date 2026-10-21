/**
 * The one authoritative `SDKResultMessage` to subtask-status mapper (RUNTIME-013, CONTEXT_PACK §4.4).
 *
 * Pure and dependency-free so the agent runtime, the `AgentSessionWorkflow` and any later consumer share
 * a single copy: a second switch anywhere else is exactly the drift this module exists to prevent.
 * Apps may not import each other (docs/architecture/dependency-graph.md), so the mapper lives in the
 * domain package that both `apps/agent-runtime` and `apps/worker` may depend on. It is exported as the
 * `@blackwing/domain/session-result` subpath, with no imports, because the workflow bundle cannot load
 * the package root (it reaches Node built-ins through `@blackwing/contracts`).
 *
 * This is the SUBTASK status (ORCH-007 enum). It is never a test-case status: `test_cases.status` is
 * written only by the orchestrator through `mark_test_case_status`.
 */

/** ORCH-007 subtask status enum. */
export const SUBTASK_STATUSES = [
  'submitted',
  'blocked',
  'failed',
  'model_declined',
  'deferred',
] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

/** The `SDKResultMessage` subtypes of §4.4. */
export const SDK_RESULT_SUBTYPES = [
  'success',
  'error_max_turns',
  'error_max_budget_usd',
  'error_during_execution',
  'error_max_structured_output_retries',
  'tool_deferred',
] as const;
export type SdkResultSubtype = (typeof SDK_RESULT_SUBTYPES)[number];

/** The fields of an `SDKResultMessage` the mapper reads. `subtype` stays a string: unknown values fail closed. */
export interface SdkResultLike {
  readonly subtype: string;
  readonly is_error?: boolean | undefined;
  /** `'refusal'` when the model declined the work (§4.4). */
  readonly stop_reason?: string | null | undefined;
}

export interface SubtaskOutcome {
  readonly status: SubtaskStatus;
  /** Machine-readable reason, set for every status except a clean `submitted`. */
  readonly reason?: string;
  /** True when the model refused; the caller records a coverage-manifest entry. */
  readonly declined: boolean;
}

/** Stop reason the SDK reports when the model refuses. */
export const REFUSAL_STOP_REASON = 'refusal';

const BY_SUBTYPE: Readonly<Record<SdkResultSubtype, SubtaskOutcome>> = {
  success: { status: 'submitted', declined: false },
  error_max_turns: { status: 'blocked', reason: 'error_max_turns', declined: false },
  error_max_budget_usd: { status: 'blocked', reason: 'error_max_budget_usd', declined: false },
  error_during_execution: { status: 'failed', reason: 'error_during_execution', declined: false },
  error_max_structured_output_retries: {
    status: 'failed',
    reason: 'error_max_structured_output_retries',
    declined: false,
  },
  tool_deferred: { status: 'deferred', reason: 'tool_deferred', declined: false },
};

function isKnownSubtype(subtype: string): subtype is SdkResultSubtype {
  return (SDK_RESULT_SUBTYPES as readonly string[]).includes(subtype);
}

/**
 * Maps one result message to a subtask outcome. A refusal wins over every subtype (a refused
 * `success` is not a submission). A `success` flagged `is_error`, and any unknown subtype, fail
 * closed to `failed` rather than being reported as work done.
 */
export function mapResult(result: SdkResultLike): SubtaskOutcome {
  if (result.stop_reason === REFUSAL_STOP_REASON) {
    return { status: 'model_declined', reason: REFUSAL_STOP_REASON, declined: true };
  }
  if (!isKnownSubtype(result.subtype)) {
    return { status: 'failed', reason: `unknown_subtype:${result.subtype}`, declined: false };
  }
  if (result.subtype === 'success' && result.is_error === true) {
    return { status: 'failed', reason: 'success_flagged_error', declined: false };
  }
  return BY_SUBTYPE[result.subtype];
}
