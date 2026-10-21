// Types and constants shared by the workflow bundle and the activities (ORCH-003). Type-only imports
// and plain values: this file is bundled for the deterministic workflow sandbox (no Node built-ins).

/** Workflow type name of the preflight phase; the run workflow starts it as a child by this name. */
export const PREFLIGHT_WORKFLOW = 'PreflightWorkflow';

/**
 * Every preflight check, in canonical order (the order reports list them and "first failing check" is
 * decided in). `verifyAuthorisation` is the §8.1 envelope check the SA-expired/revoked rules need.
 */
export const PREFLIGHT_CHECK_IDS = [
  'verifyAuthorisation',
  'resolveAndScopeTargets',
  'verifyAssetsVerified',
  'loginPerRole',
  'assertLockoutExemption',
  'assertWindowOpen',
  'deliverSocNotice',
  'assertBudgetsAvailable',
  'assertModelProviderReachable',
] as const;
export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];

/**
 * Stage 1: gates answered from our own records. They run first so that nothing touches a target (DNS,
 * login, notice) for a run that is not authorised, verified, inside its window and within budget.
 */
export const GATE_CHECK_IDS: readonly PreflightCheckId[] = Object.freeze<PreflightCheckId[]>([
  'verifyAuthorisation',
  'verifyAssetsVerified',
  'assertLockoutExemption',
  'assertWindowOpen',
  'assertBudgetsAvailable',
]);

/** Stage 2: checks that call other services or the target; they run concurrently once the gates pass. */
export const LIVE_CHECK_IDS: readonly PreflightCheckId[] = Object.freeze<PreflightCheckId[]>([
  'resolveAndScopeTargets',
  'loginPerRole',
  'deliverSocNotice',
  'assertModelProviderReachable',
]);

/** Stable failure codes; they appear in the report, `status_reason` and audit events. */
export type PreflightFailCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_IN_PREFLIGHT'
  | 'SA_EXPIRED'
  | 'SA_REVOKED'
  | 'SA_NOT_ACTIVE'
  | 'ASSET_NOT_VERIFIED'
  | 'WINDOW_CLOSED'
  | 'LOCKOUT_EXEMPTION_MISSING'
  | 'TARGET_OUT_OF_SCOPE'
  | 'TARGET_UNRESOLVABLE'
  | 'TARGET_PRIVATE_ADDRESS'
  | 'ROLE_LOGIN_FAILED'
  | 'SOC_NOTICE_FAILED'
  | 'SOC_NOTICE_UNCONFIRMED'
  | 'BUDGET_EXHAUSTED'
  | 'MODEL_PROVIDER_UNREACHABLE'
  | 'CHECK_UNAVAILABLE'
  | 'CHECK_CANCELLED'
  | 'CHECK_NOT_RUN';

export type PreflightCheckStatus = 'pass' | 'fail' | 'skip';

/** One check's answer. `detail` is operator-readable and never carries a secret (§8.7). */
export interface PreflightCheckResult {
  readonly id: PreflightCheckId;
  readonly status: PreflightCheckStatus;
  readonly detail: string;
  /** Set on `fail`, and on a `skip` that records why a check did not run. */
  readonly code?: PreflightFailCode;
  /** `assertWindowOpen` only: when the open window closes, for the ORCH-011 timer. */
  readonly windowEndsAt?: string;
}

/** Persisted to `runs.preflight_report` (jsonb). */
export interface PreflightReport {
  readonly checks: readonly PreflightCheckResult[];
  readonly ok: boolean;
  /** End of the open test window, or `null` when the window check did not pass. */
  readonly windowEndsAt: string | null;
}

/** What the run workflow applies to the state machine (ORCH-001) after preflight. */
export type PreflightEvent = 'preflight_passed' | 'fail' | 'sa_expired';

export interface PreflightDecision {
  readonly event: PreflightEvent;
  /** `runs.status_reason`: `preflight_failed:<checkId>:<CODE>`; `null` when preflight passed. */
  readonly statusReason: string | null;
  readonly report: PreflightReport;
}

export interface PreflightRef {
  readonly tenantId: string;
  readonly runId: string;
}

export interface PreflightWorkflowInput extends PreflightRef {
  /** Per-check retry cap for transient failures (default {@link DEFAULT_CHECK_ATTEMPTS}). */
  readonly maxAttemptsPerCheck?: number;
}

export const DEFAULT_CHECK_ATTEMPTS = 3;

export interface FinishPreflightInput extends PreflightRef {
  readonly report: PreflightReport;
  readonly durationMs: number;
}

/** Activities the preflight workflow calls: one per check (named by id) plus the two bookends. */
export type PreflightActivities = {
  startPreflight(ref: PreflightRef): Promise<void>;
  finishPreflight(input: FinishPreflightInput): Promise<void>;
} & Record<PreflightCheckId, (ref: PreflightRef) => Promise<PreflightCheckResult>>;
