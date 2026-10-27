import type { ClaimedOutboxRow } from '@blackwing/db';

/** Delivers one claimed row to its destination. Rejects on any failure; must be safe to repeat (at-least-once). */
export type OutboxDispatcher = (row: ClaimedOutboxRow) => Promise<void>;

/** The `notifications` BullMQ queue, as the `notify.send` dispatcher needs it. */
export interface NotificationQueue {
  /** Adds a job once: a repeated `jobId` while the job is retained is a no-op. */
  add(job: {
    readonly jobId: string;
    readonly tenantId: string;
    readonly data: unknown;
  }): Promise<void>;
}

/** The slice of the Temporal client (`client.workflow`) the `temporal.signal` dispatcher needs. */
export interface WorkflowSignalSource {
  getHandle(
    workflowId: string,
    runId?: string,
  ): { signal(name: string, arg: unknown): Promise<void> };
}

/** Relay counters and gauges (OBS wires these to Prometheus; see `createOtelOutboxMetrics`). */
export interface OutboxRelayMetrics {
  /** `outbox_dispatched_total{type}` */
  dispatched(type: string): void;
  /** `outbox_failed_total{type}`: a row became terminally `failed` (alert on any increase). */
  failed(type: string): void;
  /** `outbox_retry_total{type}`: a delivery failed and was rescheduled. */
  retried(type: string): void;
  /** `outbox_dispatch_latency_seconds`: from the row's creation to its dispatch. */
  dispatchLatency(seconds: number): void;
  /** `outbox_backlog{type}`: pending rows of the type. */
  backlog(type: string, count: number): void;
}
