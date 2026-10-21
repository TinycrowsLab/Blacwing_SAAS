import type {
  DestroyRequest,
  FlushEvidenceRequest,
  IssueKeyRequest,
  IssuedKey,
  ModelUsageEntry,
  ProvisionRequest,
  ProvisionedSandbox,
  RevokeKeyRequest,
  RunSessionRequest,
  SessionAuditEvent,
  SessionFinishRecord,
  SessionStartRecord,
  CoverageDeclinedRecord,
  TeardownFailureRequest,
} from './types.js';

/**
 * Ports the agent-session activities depend on. Their adapters are owned elsewhere: the sandbox
 * controller client (SANDBOX), the model-gateway key API, the agent-runtime transport, the Postgres
 * repositories for `agent_sessions`, `cost_ledger` and the coverage manifest, and the audit writer.
 */

/** The sandbox controller (`apps/sandbox-controller`): KubernetesDriver in prod, DockerDriver in dev. */
export interface SandboxService {
  /**
   * Creates a gVisor, read-only-rootfs, cap-drop-ALL sandbox with no host Docker socket (§1.1) and the
   * egress limited to the three allowed destinations (§4.1). Must clean up after its own failure, and be
   * idempotent by `sessionRef`. With `differentNode` it must avoid the node the first attempt used.
   */
  provision(request: ProvisionRequest, signal: AbortSignal): Promise<ProvisionedSandbox>;
  /** Idempotent: an unknown or already-gone sandbox succeeds. `sandboxId: null` resolves by `sessionRef`. */
  destroy(request: DestroyRequest, signal: AbortSignal): Promise<void>;
  /** Queues a retry of the teardown outside the workflow (orphan reaper). */
  scheduleOrphanTeardown(request: TeardownFailureRequest): Promise<void>;
}

/** The model gateway's virtual-key API (`bwk_...`). The raw key is resolved only inside the runtime transport. */
export interface VirtualKeyService {
  issue(request: IssueKeyRequest): Promise<IssuedKey>;
  /** Idempotent: revoking an already-revoked key succeeds. */
  revoke(request: RevokeKeyRequest): Promise<void>;
}

/** Hosts the Claude Agent SDK `query()` in the sandbox (`apps/agent-runtime`). */
export interface SessionRuntime {
  /**
   * Runs one session with the §4.3 options. `signal` aborts the SDK (the runtime wires it to its
   * `abortController`); `heartbeat` must be called as progress streams so a lost worker is noticed.
   */
  run(
    request: RunSessionRequest,
    signal: AbortSignal,
    heartbeat: (progress: SessionProgress) => void,
  ): Promise<unknown>;
}

export interface SessionProgress {
  readonly turns: number;
  readonly costUsd: number;
}

/** Flushes buffered evidence from the sandbox; idempotent by artifact `sha256`. */
export interface EvidenceFlusher {
  flush(request: FlushEvidenceRequest, signal: AbortSignal): Promise<void>;
}

/** `agent_sessions` rows (§8.9 pins). Both writes are upserts keyed by `(tenantId, sessionRef)`. */
export interface AgentSessionRepo {
  start(record: SessionStartRecord): Promise<void>;
  finish(record: SessionFinishRecord): Promise<void>;
}

export interface CostLedgerEntry {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionRef: string;
  readonly persona: string;
  readonly model: string;
  readonly usage: ModelUsageEntry;
}

/** `cost_ledger`. Idempotent by `(sessionRef, model)` so a retried activity never double-counts. */
export interface CostLedger {
  record(entries: readonly CostLedgerEntry[]): Promise<void>;
}

/** The coverage manifest: a refusal is recorded so reports show what was not tested. */
export interface CoverageManifest {
  recordDeclined(record: CoverageDeclinedRecord): Promise<void>;
}

export interface SessionAuditSink {
  emit(event: SessionAuditEvent): Promise<void>;
}

export interface SessionAlerts {
  /** `sandbox.orphaned` and its key counterpart. */
  teardownFailed(request: TeardownFailureRequest): Promise<void>;
}

export interface SessionMetrics {
  sessionFinished(persona: string, subtype: string, costUsd: number): void;
  sandboxProvisioned(seconds: number): void;
  sandboxTornDown(seconds: number): void;
}

/** The slice of the Temporal activity context the session activity needs. */
export interface ActivityContextLike {
  /** Aborts when the activity is cancelled (kill, parent cancel) or times out. */
  readonly cancellationSignal: AbortSignal;
  heartbeat(details?: unknown): void;
}
