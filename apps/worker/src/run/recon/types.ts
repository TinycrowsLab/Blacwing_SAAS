// Types and constants shared by the workflow bundle and the activities (ORCH-004). Type-only imports
// and plain values: this file is bundled for the deterministic workflow sandbox (no Node built-ins).

import type { RunBudget, RunMode } from '@blackwing/contracts';
import type { ReconIntrusiveness, ReconManifestWarning, ReconPersona } from '@blackwing/domain';

/** Workflow type name of the recon phase; the run workflow starts it as a child by this name. */
export const RECON_WORKFLOW = 'ReconWorkflow';

/** Stable failure codes; they appear in `status_reason` and the audit events. */
export type ReconFailCode =
  'RUN_NOT_FOUND' | 'RUN_NOT_IN_RECON' | 'RECON_ALL_SESSIONS_FAILED' | 'RECON_EMPTY_SURFACE';

export interface ReconRef {
  readonly tenantId: string;
  readonly runId: string;
}

export interface ReconWorkflowInput extends ReconRef {
  /** Retry cap for the bookkeeping activities (default {@link DEFAULT_RECON_ATTEMPTS}). */
  readonly maxAttempts?: number;
}

export const DEFAULT_RECON_ATTEMPTS = 5;

/**
 * Input of one recon `AgentSessionWorkflow` child. Every child inherits `tenantId` (tenant isolation) and
 * carries the intrusiveness it is dispatched with, which is never above `active_safe`.
 */
export interface ReconSessionInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly phase: 'recon';
  readonly persona: ReconPersona;
  readonly mode: RunMode;
  readonly intrusiveness: ReconIntrusiveness;
  /** White box confirms the deployed surface only. */
  readonly minimal: boolean;
  readonly budget: RunBudget;
}

/** How the child itself reports it ended. `model_declined` and `error_max_budget_usd` are SDK result subtypes. */
export type ReconSessionStatus = 'completed' | 'model_declined' | 'error_max_budget_usd' | 'error';

export interface ReconSessionResult {
  readonly sessionId: string;
  readonly status: ReconSessionStatus;
  /** Model spend of the session in USD. */
  readonly costUsd: number;
}

/**
 * What the phase records per persona. Adds the outcomes only the parent can observe: `failed` (the child
 * crashed or was rejected), `cost_cap` (stopped because recon would exceed its budget) and `cancelled`.
 */
export type ReconSessionOutcome = ReconSessionStatus | 'failed' | 'cost_cap' | 'cancelled';

/** Outcomes that count as a failed persona for the "all recon children failed" rule. */
export const FAILED_OUTCOMES: readonly ReconSessionOutcome[] = ['failed', 'error'];

export interface ReconSessionRecord {
  readonly persona: ReconPersona;
  readonly sessionId: string;
  readonly outcome: ReconSessionOutcome;
  readonly costUsd: number;
}

/** What `startRecon` hands the workflow: the sessions to dispatch, resolved from mode and budgets. */
export type ReconStart =
  | {
      readonly ok: true;
      readonly sessions: readonly Omit<ReconSessionInput, 'sessionId'>[];
      /** Cost allowance of the whole phase, USD. */
      readonly reconCostCapUsd: number;
      readonly warnings: readonly ReconManifestWarning[];
    }
  | {
      readonly ok: false;
      readonly code: Extract<ReconFailCode, 'RUN_NOT_FOUND' | 'RUN_NOT_IN_RECON'>;
    };

export type SurfaceFinalisation =
  | {
      readonly ok: true;
      readonly hosts: number;
      readonly endpoints: number;
      readonly supplied: boolean;
    }
  | { readonly ok: false; readonly code: 'RECON_EMPTY_SURFACE' };

/** What the run workflow applies to the state machine (ORCH-001) after recon. */
export type ReconEvent = 'recon_complete' | 'fail';

export interface ReconDecision {
  readonly event: ReconEvent;
  /** `runs.status_reason`: `recon_failed:<CODE>`; `null` when recon completed. */
  readonly statusReason: string | null;
  readonly sessions: readonly ReconSessionRecord[];
  readonly costUsd: number;
}

export interface CompleteReconInput extends ReconRef {
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  readonly code?: ReconFailCode;
  readonly sessions: readonly ReconSessionRecord[];
  /** Epoch milliseconds the phase started at (`workflowInfo().startTime`); the activity measures to its own clock. */
  readonly startedAtMs: number;
}

export interface SessionStartedInput extends ReconRef {
  readonly persona: ReconPersona;
  readonly sessionId: string;
}

export interface SessionFinishedInput extends SessionStartedInput {
  readonly mode: RunMode;
  readonly outcome: ReconSessionOutcome;
  readonly costUsd: number;
}

/** Activities the recon workflow calls. Every one is idempotent: Temporal may retry it. */
export interface ReconActivities {
  /** Loads the run, resolves the manifest, audits `recon.started`. A definitive refusal is a value. */
  startRecon(ref: ReconRef): Promise<ReconStart>;
  /** Audits `recon.session.started` for one persona. */
  recordSessionStarted(input: SessionStartedInput): Promise<void>;
  /** Audits `recon.session.finished` and counts the metric. */
  recordSessionFinished(input: SessionFinishedInput): Promise<void>;
  /** Asserts the surface model has at least one host or endpoint node. Throws when the read fails (retried). */
  finaliseSurfaceModel(ref: ReconRef): Promise<SurfaceFinalisation>;
  /** Audits `recon.completed` and records the phase duration. Must succeed before the event is applied. */
  completeRecon(input: CompleteReconInput): Promise<void>;
}
