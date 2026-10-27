// Types and constants shared by the workflow bundle and the activities (ORCH-005). Type-only imports
// and plain values: this file is bundled for the deterministic workflow sandbox (no Node built-ins).

/** Workflow type name of the planning phase; the run workflow starts it as a child by this name. */
export const PLANNING_WORKFLOW = 'PlanningWorkflow';
/** Signal an authorised approver sends to decide Gate 1. */
export const GATE1_DECISION_SIGNAL = 'gate1Decision';
/** Query returning {@link PlanningProgress}. */
export const PLANNING_PROGRESS_QUERY = 'planningProgress';

/** Planner sessions per planning round: the first attempt and one retry after invalid output. */
export const MAX_PLANNER_ATTEMPTS = 2;
/** How long Gate 1 may wait before it pages, in hours (`gate1_timeout_hours`). */
export const DEFAULT_GATE1_TIMEOUT_HOURS = 72;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- one hour in milliseconds
export const MS_PER_HOUR = 60 * 60 * 1000;

export interface PlanningRef {
  readonly tenantId: string;
  readonly runId: string;
}

export interface PlanningInput extends PlanningRef {
  /** Hours Gate 1 may wait before it pages (default {@link DEFAULT_GATE1_TIMEOUT_HOURS}). */
  readonly gate1TimeoutHours?: number;
}

/** What an approver does with a rejected plan: plan again, or cancel the run. */
export type Gate1RejectNext = 'replan' | 'cancel';

/**
 * Payload of the `gate1Decision` signal. The actor is the authenticated user the API resolved;
 * `planVersion` is the version the approver reviewed (optimistic concurrency, a stale one is refused).
 */
export type Gate1DecisionSignal =
  | {
      readonly actorId: string;
      readonly planVersion: number;
      readonly decision: 'approved';
      readonly reason?: string;
    }
  | {
      readonly actorId: string;
      readonly planVersion: number;
      readonly decision: 'rejected';
      readonly next: Gate1RejectNext;
      readonly reason: string;
    };

/** Why a proposed plan was not persisted. Only `PLAN_EMPTY` is final; the others get one retry. */
export type PlanRejectionCode =
  'PLAN_INVALID' | 'CLASS_FORBIDDEN' | 'CLASS_EXCEEDS_SA' | 'PLAN_EMPTY';

export type ProposeResult =
  | {
      readonly outcome: 'persisted';
      readonly planId: string;
      readonly version: number;
      readonly testCaseCount: number;
    }
  | {
      readonly outcome: 'rejected';
      readonly code: PlanRejectionCode;
      /** Paths and messages only, never plan values: it is fed back to the planner as feedback. */
      readonly detail: string;
    };

export type Gate1RefusalCode =
  | 'GATE1_SIGNAL_INVALID'
  | 'GATE1_RUN_NOT_AWAITING'
  | 'SOD_VIOLATION'
  | 'FORBIDDEN'
  | 'PLAN_VERSION_CONFLICT'
  | 'SA_EXPIRED'
  | 'SA_NOT_ACTIVE';

/** Result of a Gate 1 signal. A refusal is a value (never retried); `terminal` ends the workflow. */
export type Gate1Verdict =
  | { readonly accepted: true; readonly outcome: 'approved' | 'replan' | 'cancelled' }
  | {
      readonly accepted: false;
      readonly code: Gate1RefusalCode;
      /** The refusal ended the run (the SA expired): the workflow stops waiting. */
      readonly terminal: boolean;
      /** Set with `GATE1_RUN_NOT_AWAITING`: the state the run is in, which the workflow follows. */
      readonly runState?: string;
    };

export interface PlanningProgress {
  readonly phase: 'planning' | 'awaiting_gate1' | 'approved' | 'cancelled';
  readonly round: number;
  readonly gate1Pages: number;
}

export interface PlanningResult {
  readonly outcome: 'approved' | 'cancelled';
  readonly rounds: number;
  /** Version of the plan that was approved; absent when the run was cancelled. */
  readonly planVersion?: number;
  readonly autoApproved: boolean;
  readonly gate1Pages: number;
}

/** Activities the workflow calls. Every one is idempotent: Temporal may retry it. */
export interface PlanningActivities {
  /**
   * Runs one planner session for `round`, validates its structured output (schema, `PLAN_EMPTY`,
   * `CLASS_FORBIDDEN`, SA ceiling) and persists the plan only when it is acceptable. A rejection is a
   * value; a planner that cannot answer throws and the activity is retried.
   */
  proposePlan(
    ref: PlanningRef & {
      readonly round: number;
      readonly attempt: number;
      readonly feedback?: string;
    },
  ): Promise<ProposeResult>;
  /** Applies `fail` with the rejection code as the reason and audits it. */
  failPlanning(ref: PlanningRef & { readonly code: PlanRejectionCode }): Promise<void>;
  /** Applies `plan_proposed` (-> `awaiting_gate1`), audits `gate1.requested` and returns when it was requested. */
  requestGate1(
    ref: PlanningRef & { readonly planId: string; readonly version: number },
  ): Promise<{ readonly requestedAt: string }>;
  /**
   * Approves under the SA when, and only when, every test case is inside it (re-evaluated here, never
   * trusted from the caller). `approved: false` means a human must decide.
   */
  autoApprove(
    ref: PlanningRef & { readonly planId: string; readonly version: number },
  ): Promise<{ readonly approved: boolean }>;
  /** Authorises (SoD, permission, SA still valid, plan version) and applies one Gate 1 decision. */
  decideGate1(
    ref: PlanningRef & { readonly signal: Gate1DecisionSignal; readonly requestedAt: string },
  ): Promise<Gate1Verdict>;
  /** Pages the on-call approver that Gate 1 has waited too long. Never approves anything. */
  pageGate1Timeout(ref: PlanningRef & { readonly page: number }): Promise<void>;
  /** Kill/cancel cleanup (ORCH-013): stops the planner session for the run. */
  abortPlanning(ref: PlanningRef): Promise<void>;
}
