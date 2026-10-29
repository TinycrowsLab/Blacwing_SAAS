import type { RunStateFacts } from '../postexec/ports.js';
import type {
  DispatchRejectionCode,
  IntrusivenessClass,
  SubtaskBrief,
  SubtaskLifecycleStatus,
} from '@blackwing/contracts';

/**
 * Ports the dispatch layer depends on (ORCH-007). Adapters (Postgres repositories under RLS, the persona
 * registry, the reversal journal, the concurrency accountant of ORCH-009, the audit writer) are owned
 * elsewhere. A port that throws means "could not answer": the activity is retried, nothing is dispatched.
 */

/** What the registry knows about a persona: mandate metadata and the settings a session is pinned to. */
export interface PersonaProfile {
  readonly name: string;
  readonly version: string;
  /** Free-text mandate that names the CWE, WSTG, OWASP and API ids the persona covers. */
  readonly mandate: string;
  readonly intrusivenessCeiling: IntrusivenessClass;
  /** Resolved (tier to concrete model) and pinned for the run. */
  readonly model: string;
  readonly effort: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
}

export interface PersonaRegistry {
  /** Null when the name is not in the registry. */
  lookup(name: string): PersonaProfile | null;
}

/** The planned test case a subtask serves, read under the run's tenant. */
export interface DispatchTestCase {
  readonly id: string;
  readonly class: IntrusivenessClass;
  readonly status: string;
  readonly owasp: readonly string[];
  readonly wstg: readonly string[];
  readonly cwe: readonly string[];
}

export interface TestCaseReader {
  get(tenantId: string, runId: string, testCaseId: string): Promise<DispatchTestCase | null>;
}

/** §8.3: a state-changing action needs its reversal-journal entry written BEFORE it executes. */
export interface ReversalJournalReader {
  hasPreEntry(tenantId: string, runId: string, testCaseId: string): Promise<boolean>;
}

export interface SubtaskRow {
  readonly subtaskId: string;
  readonly testCaseId: string;
  readonly persona: string;
  readonly brief: SubtaskBrief;
  readonly egressIdentity: string;
  readonly status: SubtaskLifecycleStatus;
  readonly sessionId: string | null;
  readonly sandboxId: string | null;
  /** Reason or outcome detail; null until the session ends. */
  readonly result: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly costUsd: number;
}

/** `subtasks` rows, tenant-scoped (RLS). */
export interface SubtaskStore {
  /**
   * Inserts the row with `status = 'dispatched'`, or returns the existing one. A unique constraint on
   * `subtaskId` makes a concurrent duplicate lose cleanly (`created: false`).
   */
  insert(
    tenantId: string,
    runId: string,
    row: Pick<SubtaskRow, 'subtaskId' | 'testCaseId' | 'persona' | 'brief' | 'egressIdentity'>,
  ): Promise<{ readonly row: SubtaskRow; readonly created: boolean }>;
  get(tenantId: string, runId: string, subtaskId: string): Promise<SubtaskRow | null>;
  /** Compare-and-set from `from`; false when the row was not in that state (a replayed update). */
  transition(
    tenantId: string,
    runId: string,
    subtaskId: string,
    from: readonly SubtaskLifecycleStatus[],
    next: {
      readonly status: SubtaskLifecycleStatus;
      readonly sessionId?: string | null;
      readonly sandboxId?: string | null;
      readonly result?: SubtaskRow['result'];
      readonly costUsd?: number;
    },
  ): Promise<boolean>;
}

export type SlotOutcome = 'acquired' | 'limit' | 'budget';

/** Concurrency-slot and budget accounting (ORCH-009). `acquire` is idempotent per `subtaskId`. */
export interface ConcurrencySlots {
  acquire(tenantId: string, runId: string, subtaskId: string): Promise<SlotOutcome>;
  /** Idempotent: releasing a slot that is not held succeeds. */
  release(tenantId: string, runId: string, subtaskId: string): Promise<void>;
}

export interface RunStateReader {
  load(tenantId: string, runId: string): Promise<RunStateFacts | null>;
}

export interface DispatchAuditRecord {
  readonly action: 'subtask.dispatched' | 'subtask.rejected' | 'subtask.result_fetched';
  readonly outcome: 'success' | 'failure';
  readonly tenantId: string;
  readonly runId: string;
  /** Stable per subtask and event, so a retried activity cannot append a duplicate. */
  readonly dedupeKey: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DispatchAuditSink {
  append(record: DispatchAuditRecord): Promise<void>;
}

export interface DispatchMetrics {
  /** `blackwing_subtasks_total{persona,status}`. */
  subtask(persona: string, status: SubtaskLifecycleStatus): void;
  /** `blackwing_dispatch_rejections_total{reason}`. */
  rejection(reason: DispatchRejectionCode): void;
}
