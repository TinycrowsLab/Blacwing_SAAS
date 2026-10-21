import type { TestWindow } from '@blackwing/contracts';

// Types and constants shared by the workflow bundle and the activities. Type-only imports and plain
// values: this file is bundled for the deterministic workflow sandbox (no Node built-ins).

/** Workflow type name. ORCH-002's run workflow starts this as a child (or the API starts it) by this name. */
export const SA_TIME_BOUNDS_WORKFLOW = 'SaTimeBoundsWorkflow';
/** Signal: the SA was revoked mid-run. Treated exactly like expiry (§8.1). */
export const SA_REVOKED_SIGNAL = 'saRevoked';
/** Signal: the SA's window schedule or expiry was edited; carries the new bounds. */
export const SA_BOUNDS_EDITED_SIGNAL = 'saBoundsEdited';
/** Signal: the run reached a terminal state by another path; the timers stand down. */
export const RUN_FINISHED_SIGNAL = 'runFinished';
/** Query: where the guard is, for the run workflow and the reconciler. */
export const SA_BOUNDS_STATUS_QUERY = 'saBoundsStatus';

/** The SA fields the timers depend on (§7). All instants are ISO-8601 UTC. */
export interface SaTimeBounds {
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly testWindows: readonly TestWindow[];
}

export interface SaTimeBoundsInput extends SaTimeBounds {
  readonly tenantId: string;
  readonly runId: string;
  readonly saId: string;
}

/** Where the SA stands at `now`. `closeAt` is set only when `open`, `nextOpenAt` only when `closed`. */
export interface SaTimeline {
  readonly now: string;
  readonly phase: 'open' | 'closed' | 'expired';
  readonly expiresAt: string;
  readonly closeAt: string | null;
  readonly nextOpenAt: string | null;
  /** Windows that could not be evaluated (bad cron or zone). They count as closed. */
  readonly invalidWindows: number;
}

/** What the activity hands the workflow: the timeline plus the wait to the next boundary. */
export interface SaTimelineStep {
  readonly timeline: SaTimeline;
  /** Milliseconds until the next instant the state can change; at least 1. */
  readonly waitMs: number;
}

export type SaStopReason = 'sa_expired' | 'sa_revoked';

export type SaBoundsAuditEvent =
  'sa.expired' | 'window.closed' | 'window.reopened' | 'egress.blocked';

export interface SaBoundsAuditInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly saId: string;
  readonly event: SaBoundsAuditEvent;
  /** Opaque, non-secret fields only (reason, instants, outcome). */
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RunRef {
  readonly tenantId: string;
  readonly runId: string;
}

/** Ids carried for logs only. */
export interface SaRef extends RunRef {
  readonly saId: string;
}

export type WindowCloseOutcome = 'paused' | 'terminated' | 'ignored';
export type WindowReopenOutcome = 'resumed' | 'ignored';

/** What the workflow calls. Every activity is idempotent: Temporal may retry or replay it. */
export interface SaBoundsActivities {
  /** Evaluates the bounds at the worker's clock (workflows never read the wall clock). */
  evaluateTimeline(input: SaTimeBounds & SaRef): Promise<SaTimelineStep>;
  /**
   * Blocks all target traffic for the run at the egress gateway. Resolves only when the gateway
   * acknowledged (`already_blocked` counts); throws otherwise so Temporal retries.
   */
  blockEgress(
    input: SaRef & { readonly reason: SaStopReason | 'window_closed'; readonly triggerAt: string },
  ): Promise<{ readonly outcome: 'blocked' | 'already_blocked'; readonly latencyMs: number }>;
  /**
   * Ends the run's agent sessions after egress is blocked. In-flight `state_changing` actions finish
   * their reversal-journal obligation first; the session manager owns that drain.
   */
  cancelSessions(input: RunRef): Promise<void>;
  /** Pauses the run's sessions without ending them (window closed, more windows to come). */
  pauseSessions(input: RunRef): Promise<void>;
  /** Moves the run to `expired`, the terminal state (`sa_expired` event). A no-op once terminal. */
  finaliseExpired(input: RunRef & { readonly reason: SaStopReason }): Promise<void>;
  /**
   * Window closed: `terminal=false` pauses the run until the next window; `terminal=true` applies the
   * `window_closed` event (no further window before expiry). Ignored once the run is terminal.
   */
  applyWindowClosed(input: RunRef & { readonly terminal: boolean }): Promise<WindowCloseOutcome>;
  /** Window reopened: resumes a run paused for the window; ignored in any other state. */
  applyWindowReopened(input: RunRef): Promise<WindowReopenOutcome>;
  resumeSessions(input: RunRef): Promise<void>;
  audit(input: SaBoundsAuditInput): Promise<void>;
}

export type SaBoundsPhase = 'waiting' | 'open' | 'closed' | 'stopped' | 'finished';

export interface SaBoundsStatus {
  readonly phase: SaBoundsPhase;
  readonly expiresAt: string;
  readonly windowCloseAt: string | null;
  readonly nextOpenAt: string | null;
  /** Set once the stop sequence ran. */
  readonly stoppedFor: SaStopReason | 'window_closed' | null;
}
