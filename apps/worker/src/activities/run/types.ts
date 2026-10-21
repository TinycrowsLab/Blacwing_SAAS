import type { RunPauseReason, RunState, RunStateView } from '@blackwing/contracts';
import type { RunActor, RunAuditIntent } from '@blackwing/domain/run';

// Types and constants shared by the AssessmentRunWorkflow bundle and its activities (ORCH-002).
// Type-only imports and plain values: this file is bundled for the deterministic workflow sandbox.

/** Reference every run activity carries: the tenant is threaded into each one so DB writes set `app.tenant_id` (§7). */
export interface RunRef {
  readonly tenantId: string;
  readonly runId: string;
}

export interface PersistRunStateRequest extends RunRef {
  readonly from: RunState;
  readonly to: RunState;
  /** Set exactly when `to` is `paused`. */
  readonly pauseReason: RunPauseReason | null;
  /** The `runs.state_version` the workflow last saw; the write is `... WHERE state_version = expectedVersion`. */
  readonly expectedVersion: number;
}

/**
 * Result of `persistRunState`. A lost race is a value, not an error: Temporal's retry must not replay a
 * stale write. The implementation treats a retry of an already-applied write (row already at
 * `to` / `expectedVersion + 1`) as `ok`, so an activity retry never double-transitions.
 */
export type PersistRunStateResult =
  | { readonly outcome: 'ok'; readonly version: number }
  | { readonly outcome: 'conflict'; readonly current: RunStateView };

export interface WriteAuditRequest extends RunRef {
  readonly intent: RunAuditIntent;
  /** Signal sender for human signals, `system` otherwise (§8.8). */
  readonly actor: RunActor;
  /** Why, for controller-initiated failures. Never model output. */
  readonly detail?: string;
}

/** What a phase body reports. Closed set: a model can never choose a state, only the controller can (§8.11). */
export type PhaseResult =
  { readonly outcome: 'ok' } | { readonly outcome: 'failed'; readonly reason: string };

/** Persistence, audit and guard activities (all I/O lives here). */
export interface RunControlActivities {
  persistRunState(request: PersistRunStateRequest): Promise<PersistRunStateResult>;
  writeAudit(request: WriteAuditRequest): Promise<void>;
  /** True only when a valid, unexpired, verified envelope exists for the run (§8.1). */
  verifyEnvelope(request: RunRef & { readonly saId: string }): Promise<boolean>;
}

/**
 * Phase bodies, filled in by ORCH-003/004/005/008/014. Each one must be resumable: a paused or
 * interrupted phase is run again from its start.
 */
export interface RunPhaseActivities {
  runPreflight(request: RunRef): Promise<PhaseResult>;
  /** Sends target traffic, so it is never retried automatically. */
  runRecon(request: RunRef): Promise<PhaseResult>;
  runPlanning(request: RunRef): Promise<PhaseResult>;
  /** Sends target traffic, so it is never retried automatically. */
  runExecution(request: RunRef): Promise<PhaseResult>;
  /** Replays candidates against the target, so it is never retried automatically. */
  runValidation(request: RunRef): Promise<PhaseResult>;
  runReporting(request: RunRef): Promise<PhaseResult>;
}

export type RunActivities = RunControlActivities & RunPhaseActivities;
