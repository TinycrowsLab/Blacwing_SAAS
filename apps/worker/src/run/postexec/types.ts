// Types and constants shared by the workflow bundle and the activities (ORCH-009). Type-only imports
// and plain values: this file is bundled for the deterministic workflow sandbox (no Node built-ins).

/** Workflow type name of the post-execution phases; the run workflow starts it as a child by this name. */
export const POST_EXECUTION_WORKFLOW = 'PostExecutionWorkflow';
/** Signal an authorised analyst sends to decide findings at Gate 3. */
export const GATE3_RELEASED_SIGNAL = 'gate3Released';
/** Query returning {@link PostExecutionProgress}. */
export const POST_EXECUTION_PROGRESS_QUERY = 'postExecutionProgress';

/** Gate 3 triage decisions, §3.4. */
export const GATE3_DECISIONS = [
  'released',
  'rejected_false_positive',
  'duplicate',
  'accepted_risk',
] as const;
export type Gate3Decision = (typeof GATE3_DECISIONS)[number];

/** One finding's Gate 3 decision. `accepted_risk` needs `reason` and a future `expiresAt` (§3.4). */
export interface Gate3FindingDecision {
  readonly findingId: string;
  readonly decision: Gate3Decision;
  readonly reason?: string;
  /** ISO-8601 UTC instant; `accepted_risk` only. */
  readonly expiresAt?: string;
}

/** Payload of the `gate3Released` signal. The actor is the authenticated analyst the API resolved. */
export interface Gate3ReleaseSignal {
  readonly actorId: string;
  readonly decisions: readonly Gate3FindingDecision[];
}

/** Reasons a candidate ends `suspected` (analyst-only, F17). */
export type SuspectedReason =
  'ORACLE_FAILED' | 'NEGATIVE_CONTROL_FIRED' | 'EVIDENCE_MISSING' | 'VALIDATOR_UNAVAILABLE';

/** What the VALIDATE replay engine reports for one candidate (its internals are not ours). */
export interface ValidatorVerdict {
  /** The pre-declared oracle held on the deterministic replay in a fresh sandbox. */
  readonly oraclePassed: boolean;
  /** The negative control also fired: the oracle is not specific to the vulnerability (§7). */
  readonly negativeControlFired: boolean;
  /** `evidence_items` bundle (hash chained) and the standalone repro artifact (F18). */
  readonly evidenceBundleId: string | null;
  readonly reproArtifactId: string | null;
}

export type CandidateOutcome =
  | {
      readonly findingId: string;
      readonly outcome: 'confirmed';
      readonly evidenceBundleId: string;
      readonly reproArtifactId: string;
    }
  | {
      readonly findingId: string;
      readonly outcome: 'suspected';
      readonly reason: SuspectedReason;
    };

export interface PostExecutionRef {
  readonly tenantId: string;
  readonly runId: string;
}

export interface PostExecutionInput extends PostExecutionRef {
  /** Validations in flight at once (default {@link DEFAULT_VALIDATION_CONCURRENCY}). */
  readonly maxConcurrentValidations?: number;
  /** How long Gate 3 may wait before it pages, in milliseconds (default {@link DEFAULT_GATE3_PAGE_AFTER_MS}). */
  readonly gate3PageAfterMs?: number;
}

export const DEFAULT_VALIDATION_CONCURRENCY = 4;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- 24 hours in milliseconds
export const DEFAULT_GATE3_PAGE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Result of a Gate 3 signal. A refusal is a value (never retried); the workflow keeps waiting. */
export type Gate3Verdict =
  | {
      readonly accepted: true;
      readonly allDecided: boolean;
      /** Findings this signal newly released (a duplicate signal releases none). */
      readonly released: number;
      readonly refused: readonly Refusal[];
    }
  | { readonly accepted: false; readonly code: Gate3RefusalCode };

export type Gate3RefusalCode =
  'GATE3_NOT_PERMITTED' | 'GATE3_SOD_VIOLATION' | 'GATE3_RUN_NOT_AWAITING';

export type FindingRefusalCode =
  | 'FINDING_NOT_FOUND'
  | 'FINDING_NOT_CONFIRMED'
  | 'ACCEPTED_RISK_NEEDS_REASON_AND_EXPIRY'
  | 'DECISION_CONFLICT';

/** A decision on one finding that was refused while the rest of the signal was applied. */
export interface Refusal {
  readonly findingId: string;
  readonly code: FindingRefusalCode;
}

export interface PostExecutionProgress {
  readonly phase: 'validating' | 'awaiting_gate3' | 'reporting' | 'completed';
  readonly confirmed: number;
  readonly suspected: number;
  readonly undecided: number;
  readonly gate3Pages: number;
}

export interface PostExecutionResult {
  readonly confirmed: number;
  readonly suspected: number;
  readonly released: number;
  readonly gate3Pages: number;
}

export type ReporterRole = 'reporter' | 'remediation';

/** Activities the workflow calls. Every one is idempotent: Temporal may retry it. */
export interface PostExecutionActivities {
  /** Applies `validation_started`, audits `validation.started`, returns candidates still to resolve. */
  startValidation(ref: PostExecutionRef): Promise<{ readonly candidateIds: readonly string[] }>;
  /** Runs the Validator in a fresh sandbox and classifies the verdict. Throws when it cannot answer. */
  validateCandidate(
    ref: PostExecutionRef & { readonly findingId: string },
  ): Promise<CandidateOutcome>;
  /** Persists the outcome, audits `finding.confirmed` or `finding.suspected`, counts the metric. */
  recordOutcome(ref: PostExecutionRef & { readonly outcome: CandidateOutcome }): Promise<void>;
  /** Applies `gate3_requested`. Returns the confirmed findings awaiting a decision. */
  requestGate3(ref: PostExecutionRef): Promise<{ readonly pending: number }>;
  /** Authorises (permission + SoD), applies the decisions and, once all are decided, `gate3_released`. */
  decideGate3(
    ref: PostExecutionRef & { readonly signal: Gate3ReleaseSignal },
  ): Promise<Gate3Verdict>;
  /** Pages the on-call analyst that Gate 3 has waited too long. Never releases anything. */
  pageGate3Timeout(ref: PostExecutionRef & { readonly page: number }): Promise<void>;
  /** Applies `reporting_started`. */
  startReporting(ref: PostExecutionRef): Promise<void>;
  /** Starts the reporter or remediation session over the released findings. */
  runWriteUp(ref: PostExecutionRef & { readonly role: ReporterRole }): Promise<void>;
  /** Finalises the coverage manifest (F19). */
  finaliseCoverage(ref: PostExecutionRef): Promise<void>;
  /** Re-checks the manifest, then applies `completed`. Refuses (value) when it is not finalised. */
  completeRun(
    ref: PostExecutionRef,
  ): Promise<
    | { readonly completed: true }
    | { readonly completed: false; readonly code: 'COVERAGE_NOT_FINALISED' }
  >;
  /** Kill/cancel cleanup (ORCH-013): stop validation sandboxes for the run. */
  abortValidation(ref: PostExecutionRef): Promise<void>;
}
