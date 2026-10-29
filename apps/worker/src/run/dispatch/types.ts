import type { AgentSessionInput } from '../../agent-session/types.js';
import type { DispatchRejectionCode, SubtaskLifecycleStatus } from '@blackwing/contracts';
import type { SubtaskOutcome } from '@blackwing/domain/session-result';

// Types shared by the dispatch activities and the execution workflow bundle: no runtime imports.

export interface DispatchRef {
  readonly tenantId: string;
  readonly runId: string;
}

/** Answer to a dispatch. A rejection is a value (never thrown) so Temporal does not retry it. */
export type DispatchOutcome =
  | {
      readonly accepted: true;
      readonly subtaskId: string;
      readonly status: SubtaskLifecycleStatus;
      /** True when this call created the subtask; false for an idempotent repeat. */
      readonly created: boolean;
      /** Set while the subtask has no session yet: the workflow starts the child from it. */
      readonly session: AgentSessionInput | null;
    }
  | {
      readonly accepted: false;
      readonly code: DispatchRejectionCode;
      readonly message: string;
    };

export interface SubtaskResultView {
  readonly subtaskId: string;
  readonly status: SubtaskLifecycleStatus;
  readonly result: Readonly<Record<string, string | number | boolean | null>> | null;
}

export type SubtaskResultOutcome =
  ({ readonly found: true } & SubtaskResultView) | { readonly found: false };

export interface RecordSubtaskResultRequest extends DispatchRef {
  readonly subtaskId: string;
  readonly sessionId: string | null;
  readonly sandboxId: string | null;
  readonly outcome: SubtaskOutcome;
  readonly costUsd: number;
}

/** Activities of the dispatch layer, proxied by the execution workflow. */
export interface DispatchActivities {
  /** Validates and persists a dispatch request. `request` is untrusted and parsed here. */
  planDispatch(ref: DispatchRef, request: unknown): Promise<DispatchOutcome>;
  /** The child workflow started: `dispatched → running`. */
  markSubtaskRunning(ref: DispatchRef & { readonly subtaskId: string }): Promise<void>;
  /** The child ended: stores the result, releases the concurrency slot. Idempotent. */
  recordSubtaskResult(request: RecordSubtaskResultRequest): Promise<void>;
  /** `get_subtask_result`: non-blocking; a subtask still in flight reports `dispatched` or `running`. */
  getSubtaskResult(
    ref: DispatchRef & { readonly subtaskId: string },
  ): Promise<SubtaskResultOutcome>;
}

/** Name of the update the orchestrator's engagement tool sends to the Run Controller. */
export const DISPATCH_SUBTASK_UPDATE = 'dispatchSubtask';
