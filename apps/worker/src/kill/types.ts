import type {
  KillAffected,
  KillSandboxOutcome,
  KillApiScope,
  KillEgressIdentity,
  KillEgressOutcome,
  KillKeyOutcome,
  KillWorkflowOutcome,
  KillEventStatus,
  KillTargetSet,
} from '@blackwing/contracts';

// Types and constants shared by the workflow bundle and the activities. Type-only imports and plain
// values: this file is bundled for the deterministic workflow sandbox (no Node built-ins).

/** Workflow type name; the API signaler (`apps/api/src/kill/temporal-signaler.ts`) starts it by this name. */
export const KILL_PROPAGATION_WORKFLOW = 'KillPropagationWorkflow';
/** Signal carrying the target set into the workflow. */
export const KILL_TARGETS_SIGNAL = 'killTargets';
/** Query the reconciler uses to see how far a kill got, so KILL-003's enqueue-failure path can resume. */
export const KILL_PROGRESS_QUERY = 'killProgress';

/** Egress stage budget (§8.5: p99 < 2 s): at most 5 attempts inside a 2 s deadline. */
export const EGRESS_MAX_ATTEMPTS = 5;
export const EGRESS_DEADLINE_MS = 2_000;
export const EGRESS_BACKOFF_BASE_MS = 50;

/** Sandbox stage budget (§8.5: p99 < 10 s), overridable with `KILL_SANDBOX_DEADLINE_MS`. */
export const SANDBOX_DEADLINE_MS = 10_000;
export const SANDBOX_BACKOFF_BASE_MS = 100;

export interface KillWorkflowInput {
  readonly killEventId: string;
  readonly tenantId: string;
}

/** The message the API signals (mirrors `KillPropagationRequest` in `apps/api/src/kill/ports.ts`). */
export interface KillPropagationRequest {
  readonly killEventId: string;
  readonly tenantId: string;
  readonly scope: KillApiScope;
  readonly scopeRefId: string | null;
  readonly targets: KillTargetSet;
  readonly triggeredAt: string;
}

export type KillStageName = 'egress' | 'sandbox' | 'keys' | 'workflows';

/** The four stage timestamp columns of `kill_events`, one per stage, in §8.5 order. */
export type KillStageColumn =
  'egressBlockedAt' | 'sandboxesTerminatedAt' | 'keysRevokedAt' | 'workflowsCancelledAt';

export interface EgressIdentityResult {
  /** `run:<runId>` or `principal:<tc_..role_..>`; opaque ids only, never a secret. */
  readonly identity: string;
  readonly outcome: KillEgressOutcome;
}

export type EgressStageOutcome = 'blocked' | 'partially_halted' | 'skipped';

export interface EgressStageResult {
  readonly outcome: EgressStageOutcome;
  readonly identities: readonly EgressIdentityResult[];
  readonly attempts: number;
  readonly latencyMs: number;
}

export type SandboxStageOutcome = 'terminated' | 'partially_halted' | 'skipped';

export interface SandboxIdResult {
  readonly sandboxId: string;
  readonly outcome: KillSandboxOutcome;
}

export interface SandboxStageResult {
  readonly outcome: SandboxStageOutcome;
  readonly sandboxes: readonly SandboxIdResult[];
  readonly attempts: number;
  readonly latencyMs: number;
}

export const KEY_DEADLINE_MS = 10_000;
export const KEY_BACKOFF_BASE_MS = 100;
export const WORKFLOW_DEADLINE_MS = 10_000;
export const WORKFLOW_BACKOFF_BASE_MS = 100;

export type KeyStageOutcome = 'revoked' | 'partially_halted' | 'skipped';

export interface KeyIdResult {
  readonly keyId: string;
  readonly outcome: KillKeyOutcome;
}

export interface KeyStageResult {
  readonly outcome: KeyStageOutcome;
  readonly keys: readonly KeyIdResult[];
  readonly attempts: number;
  readonly latencyMs: number;
}

export type WorkflowStageOutcome = 'cancelled' | 'partially_halted' | 'skipped';

export interface WorkflowIdResult {
  readonly workflowId: string;
  readonly outcome: KillWorkflowOutcome;
}

export interface WorkflowStageResult {
  readonly outcome: WorkflowStageOutcome;
  readonly workflows: readonly WorkflowIdResult[];
  /** Pending reversal-journal entries flagged for the reversal process (not undone here). */
  readonly reversalsFlagged: number;
  readonly attempts: number;
  readonly latencyMs: number;
}

export interface KillProgress {
  readonly received: boolean;
  readonly stage: 'waiting' | KillStageName | 'finalizing' | 'done';
  readonly egress: EgressStageOutcome | null;
  readonly completed: boolean;
}

/** What the workflow calls. Every activity is idempotent: Temporal may retry or replay it. */
export interface KillActivities {
  blockEgress(input: {
    readonly tenantId: string;
    readonly killEventId: string;
    readonly identities: readonly KillEgressIdentity[];
  }): Promise<EgressStageResult>;
  auditEgressBlocked(input: {
    readonly tenantId: string;
    readonly killEventId: string;
    readonly result: EgressStageResult;
  }): Promise<void>;
  /** Stage 2: force-terminate the target sandboxes via the sandbox controller and record the ack. */
  terminateSandboxes(input: {
    readonly tenantId: string;
    readonly killEventId: string;
    readonly sandboxIds: readonly string[];
  }): Promise<SandboxStageResult>;
  auditSandboxesTerminated(input: {
    readonly tenantId: string;
    readonly killEventId: string;
    readonly result: SandboxStageResult;
  }): Promise<void>;
  /** Stage 3: revoke the virtual model keys. Expiry is the backstop when the gateway cannot be reached. */
  revokeKeys(input: {
    readonly tenantId: string;
    readonly killEventId: string;
    readonly keyIds: readonly string[];
  }): Promise<KeyStageResult>;
  auditKeysRevoked(input: {
    readonly tenantId: string;
    readonly killEventId: string;
    readonly result: KeyStageResult;
  }): Promise<void>;
  /** Stage 4: cancel the Temporal workflows and flag pending reversal entries. */
  cancelWorkflows(input: {
    readonly tenantId: string;
    readonly killEventId: string;
    readonly workflowIds: readonly string[];
    readonly runIds: readonly string[];
  }): Promise<WorkflowStageResult>;
  auditWorkflowsCancelled(input: {
    readonly tenantId: string;
    readonly killEventId: string;
    readonly result: WorkflowStageResult;
  }): Promise<void>;
  /** Empty target set: `status=halted`, `halt_ms=0`. */
  completeEmptyKill(input: {
    readonly tenantId: string;
    readonly killEventId: string;
  }): Promise<void>;
  /** Completes the event once every stage has recorded; a no-op while later stages are outstanding. */
  finalizeKill(input: {
    readonly tenantId: string;
    readonly killEventId: string;
  }): Promise<{ readonly completed: boolean }>;
}

/** A later stage (KILL-005 sandbox terminate, KILL-006 key revoke / workflow cancel) plugs in here. */
export interface KillLaterStage {
  readonly name: Exclude<KillStageName, 'egress'>;
  run(request: KillPropagationRequest): Promise<void>;
}

/** The persisted state the activities read and compare-and-set. */
export interface KillEventState {
  readonly id: string;
  readonly tenantId: string | null;
  readonly status: KillEventStatus;
  readonly triggeredAt: Date;
  readonly egressBlockedAt: Date | null;
  readonly sandboxesTerminatedAt: Date | null;
  readonly keysRevokedAt: Date | null;
  readonly workflowsCancelledAt: Date | null;
  readonly completedAt: Date | null;
  readonly affected: KillAffected;
}
