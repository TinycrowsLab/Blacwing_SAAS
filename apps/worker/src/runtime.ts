import { metrics, type ObservableCallback } from '@opentelemetry/api';

import type { WorkerConfig } from './config.js';
import type { TaskQueueName } from './task-queues.js';
import type { Logger } from '@blackwing/logger';

/** The slice of the SDK `Worker` the runtime drives (a seam for tests). */
export interface WorkerLike {
  getState(): string;
  run(): Promise<void>;
  shutdown(): void;
}

export interface WorkerRuntimeDeps {
  readonly config: WorkerConfig;
  /** Builds the (not yet running) worker for one task queue. */
  readonly createWorker: (queue: TaskQueueName) => Promise<WorkerLike>;
  /** Releases the Temporal connections once every worker has stopped. */
  readonly closeConnections: () => Promise<void>;
  readonly log: Logger;
}

interface QueueHealth {
  readonly taskQueue: TaskQueueName;
  readonly state: string;
}

export interface HealthReport {
  readonly status: 'ok' | 'unavailable';
  readonly workers: readonly QueueHealth[];
}

const RUNNING = 'RUNNING';
const START_POLL_MS = 10;

const meter = metrics.getMeter('@blackwing/worker');
const upGauge = meter.createObservableGauge('temporal_worker_up', {
  description: '1 while the worker for a task queue is polling, else 0',
});
const slotGauge = meter.createObservableGauge('temporal_worker_task_slots_max', {
  description: 'Configured maximum concurrent task executions per task queue and kind',
});

/**
 * One Temporal worker per task queue (so queues scale independently), run together in one process.
 * Owns startup, the health report and graceful shutdown.
 */
export class WorkerRuntime {
  private readonly workers = new Map<TaskQueueName, WorkerLike>();
  private runPromise: Promise<void> | undefined;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private readonly log: Logger;

  private readonly observeUp: ObservableCallback = (result) => {
    for (const [taskQueue, worker] of this.workers) {
      result.observe(worker.getState() === RUNNING ? 1 : 0, { taskQueue });
    }
  };

  private readonly observeSlots: ObservableCallback = (result) => {
    const { config } = this.deps;
    for (const taskQueue of this.workers.keys()) {
      result.observe(config.maxConcurrentActivityTaskExecutions, { taskQueue, kind: 'activity' });
      result.observe(config.maxConcurrentWorkflowTaskExecutions, { taskQueue, kind: 'workflow' });
    }
  };

  constructor(private readonly deps: WorkerRuntimeDeps) {
    this.log = deps.log.child({ component: 'temporal-worker' });
    upGauge.addCallback(this.observeUp);
    slotGauge.addCallback(this.observeSlots);
  }

  /** Creates every configured worker and starts polling. Resolves once all are running. */
  async start(): Promise<void> {
    for (const taskQueue of this.deps.config.taskQueues) {
      this.workers.set(taskQueue, await this.deps.createWorker(taskQueue));
    }
    this.runPromise = this.runAll();
    // Workers move to RUNNING asynchronously after run() is called; wait until every one has.
    while (!this.allRunning()) {
      if (this.shuttingDown) break;
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    }
    for (const taskQueue of this.workers.keys()) {
      this.log.info({ taskQueue }, 'temporal worker started');
    }
  }

  /** Resolves when every worker has stopped; rejects if one failed. */
  run(): Promise<void> {
    return this.runPromise ?? Promise.resolve();
  }

  health(): HealthReport {
    const workers = [...this.workers].map(([taskQueue, worker]) => ({
      taskQueue,
      state: worker.getState(),
    }));
    const ok =
      workers.length > 0 && workers.every((w) => w.state === RUNNING) && !this.shuttingDown;
    return { status: ok ? 'ok' : 'unavailable', workers };
  }

  /**
   * Stops polling, lets in-flight tasks drain (the SDK force-cancels activities after the grace time),
   * then closes the Temporal connections. Idempotent.
   */
  shutdown(reason: string): Promise<void> {
    this.shutdownPromise ??= this.doShutdown(reason);
    return this.shutdownPromise;
  }

  private async doShutdown(reason: string): Promise<void> {
    this.shuttingDown = true;
    this.log.info({ reason }, 'temporal worker shutdown started: draining in-flight tasks');
    for (const worker of this.workers.values()) {
      if (worker.getState() === RUNNING) worker.shutdown();
    }
    await this.run().catch(() => undefined);
    upGauge.removeCallback(this.observeUp);
    slotGauge.removeCallback(this.observeSlots);
    await this.deps.closeConnections();
    this.log.info({ reason }, 'temporal worker graceful shutdown complete');
  }

  private allRunning(): boolean {
    return [...this.workers.values()].every((worker) => worker.getState() === RUNNING);
  }

  private async runAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.workers].map(async ([taskQueue, worker]) => {
        try {
          await worker.run();
        } catch (err) {
          this.log.fatal({ taskQueue, err }, 'temporal worker failed');
          // One dead worker means an unserved queue: take the rest down rather than limp on.
          for (const other of this.workers.values()) {
            if (other.getState() === RUNNING) other.shutdown();
          }
          throw err;
        }
      }),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }
}
