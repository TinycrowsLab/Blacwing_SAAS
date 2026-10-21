import type { SdkResultLike, SubtaskOutcome } from '@blackwing/domain/session-result';

// Types and constants shared by the workflow bundle and the activities (ORCH-003). This file is bundled
// for the deterministic workflow sandbox: type-only imports and plain values, no Node built-ins.
// The result to subtask-status mapping is NOT here: it is `mapResult` in `@blackwing/domain` (RUNTIME-013).

/** Workflow type name; the parent run workflow starts it as a child by this name. */
export const AGENT_SESSION_WORKFLOW = 'AgentSessionWorkflow';

/** Default wall-clock cap for one session when the input sets none. */
export const DEFAULT_SESSION_MAX_DURATION_MS = 1_800_000;
/** The session activity must heartbeat at least this often or Temporal treats the worker as lost. */
export const SESSION_HEARTBEAT_TIMEOUT_MS = 60_000;
/** Destroy budget (§8.5: sandbox stage p99 < 10 s). Past it the sandbox is reported orphaned. */
export const SANDBOX_DESTROY_DEADLINE_MS = 10_000;
/** Temporal attempts for the teardown activities before the failure is reported. */
export const FLUSH_MAX_ATTEMPTS = 2;
export const REVOKE_MAX_ATTEMPTS = 5;
export const DESTROY_MAX_ATTEMPTS = 3;
/** Best-effort evidence flush budget during teardown. */
export const EVIDENCE_FLUSH_DEADLINE_MS = 3_000;
/** Key revocation budget during teardown. */
export const KEY_REVOKE_DEADLINE_MS = 3_000;

/** What the parent run workflow hands the child (one persona session). */
export interface AgentSessionInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly subtaskId?: string;
  readonly persona: string;
  readonly personaVersion: string;
  readonly brief: string;
  readonly model: string;
  readonly effort: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly intrusiveness: string;
  readonly roleId?: string;
  /** Opaque egress identity (`run:<runId>`); the gateway keys allow-lists and the kill block on it. */
  readonly egressIdentity: string;
  /** Wall-clock cap; the activity timeout cancels the SDK through its `abortController`. */
  readonly maxDurationMs?: number;
  /** Set by the parent when resuming a deferred session (RUNTIME-014); the session store replays it. */
  readonly resumeSessionId?: string;
}

/** Outcome returned to the parent. `subtask` is the subtask status, never a test-case status. */
export interface AgentSessionResult {
  readonly sessionRef: string;
  /** The SDK session id; the parent needs it to `resume` after Gate 2 when `subtask.status` is `deferred`. */
  readonly sessionId: string | null;
  readonly sandboxId: string;
  readonly subtask: SubtaskOutcome;
  readonly numTurns: number;
  readonly totalCostUsd: number;
}

export interface ProvisionRequest {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionRef: string;
  readonly persona: string;
  readonly egressIdentity: string;
  /** True on the single retry: the controller must schedule onto a node other than the failed one. */
  readonly differentNode: boolean;
}

export interface ProvisionedSandbox {
  readonly sandboxId: string;
  readonly workspaceDir: string;
  /** Reference to the per-run CA bundle (never the material). */
  readonly caRef: string;
}

export interface IssueKeyRequest {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionRef: string;
  readonly model: string;
  readonly maxBudgetUsd: number;
  /** Key lifetime upper bound; the key is revoked on finish or kill well before this. */
  readonly ttlMs: number;
}

/** A short-lived virtual model key, by reference only: the `bwk_...` value never enters workflow history. */
export interface IssuedKey {
  readonly keyId: string;
  readonly keyRef: string;
}

export interface RunSessionRequest {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionRef: string;
  readonly subtaskId?: string;
  readonly persona: string;
  readonly personaVersion: string;
  readonly brief: string;
  readonly model: string;
  readonly effort: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly intrusiveness: string;
  readonly roleId?: string;
  readonly egressIdentity: string;
  readonly resumeSessionId?: string;
  readonly sandboxId: string;
  readonly workspaceDir: string;
  readonly caRef: string;
  readonly keyRef: string;
}

export interface ModelUsageEntry {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly costUSD: number;
}

/** The subset of `SDKResultMessage` that leaves the sandbox. The free-text `result` is deliberately dropped. */
export interface SessionResultMessage extends SdkResultLike {
  readonly session_id: string;
  readonly num_turns: number;
  readonly total_cost_usd: number;
  readonly modelUsage: Readonly<Record<string, ModelUsageEntry>>;
}

/** §8.9 pins the runtime reports for the agent_sessions row. */
export interface SessionPins {
  readonly promptSha256: string;
  readonly sdkVersion: string;
  readonly claudeCodeVersion: string;
}

export interface RunSessionResult {
  readonly result: SessionResultMessage;
  readonly pins: SessionPins;
  /** Object key of the archived, redacted transcript. */
  readonly transcriptKey: string | null;
}

export interface SessionStartRecord {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionRef: string;
  readonly subtaskId?: string;
  readonly persona: string;
  readonly personaVersion: string;
  readonly model: string;
  readonly effort: string;
  readonly sandboxId: string;
  readonly virtualKeyId: string;
}

export interface SessionFinishRecord {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionRef: string;
  readonly persona: string;
  /** SDK result subtype (`error_during_execution` when the runtime never reported). */
  readonly subtype: string;
  /** Null when the runtime died before reporting a result. */
  readonly pins: SessionPins | null;
  readonly sessionId: string | null;
  readonly numTurns: number;
  readonly totalCostUsd: number;
  readonly modelUsage: Readonly<Record<string, ModelUsageEntry>>;
  readonly transcriptKey: string | null;
  readonly subtask: SubtaskOutcome;
}

export interface CostRecord {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionRef: string;
  readonly persona: string;
}

export interface CoverageDeclinedRecord {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionRef: string;
  readonly subtaskId?: string;
  readonly persona: string;
  readonly reason: string;
}

export type SessionAuditType =
  | 'session.started'
  | 'session.finished'
  | 'session.killed'
  | 'sandbox.provisioned'
  | 'sandbox.destroyed'
  | 'virtualkey.revoked';

export interface SessionAuditEvent {
  readonly type: SessionAuditType;
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionRef: string;
  /** Opaque ids and status only, never key material or transcript text. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TeardownRef {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionRef: string;
}

export interface DestroyRequest extends TeardownRef {
  /** Null when cancellation hit during provisioning: the controller finds the sandbox by `sessionRef`. */
  readonly sandboxId: string | null;
}

export interface RevokeKeyRequest extends TeardownRef {
  readonly keyId: string;
}

export interface FlushEvidenceRequest extends TeardownRef {
  readonly sandboxId: string;
}

/** A resource teardown could not finish: an orphaned sandbox, or a virtual key that stayed live. */
export interface TeardownFailureRequest extends TeardownRef {
  readonly kind: 'sandbox' | 'virtual_key';
  /** Sandbox id or key id; null when cancellation hit before the sandbox id was known. */
  readonly resourceId: string | null;
  readonly error: string;
}

/** Every activity the child workflow calls, in the shape `proxyActivities` sees. */
export interface AgentSessionActivities {
  provisionSandbox(request: ProvisionRequest): Promise<ProvisionedSandbox>;
  issueVirtualKey(request: IssueKeyRequest): Promise<IssuedKey>;
  recordSessionStart(record: SessionStartRecord): Promise<void>;
  runAgentSession(request: RunSessionRequest): Promise<RunSessionResult>;
  recordSessionFinish(record: SessionFinishRecord): Promise<void>;
  recordSessionCost(record: CostRecord & { result: SessionResultMessage }): Promise<void>;
  recordDeclinedCoverage(record: CoverageDeclinedRecord): Promise<void>;
  emitSessionAudit(event: SessionAuditEvent): Promise<void>;
  flushEvidence(request: FlushEvidenceRequest): Promise<void>;
  revokeVirtualKey(request: RevokeKeyRequest): Promise<void>;
  destroySandbox(request: DestroyRequest): Promise<void>;
  /** Raises `sandbox.orphaned` (or the key equivalent) and queues the out-of-band teardown retry. */
  reportTeardownFailure(request: TeardownFailureRequest): Promise<void>;
}
