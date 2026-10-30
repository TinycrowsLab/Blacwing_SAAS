/** Options for {@link DropOldestExportQueue}. Durations are milliseconds. */
export interface ExportQueueOptions<T> {
  /** Items held in memory. Past this, the oldest item is dropped: memory stays bounded (never OOM). */
  readonly maxQueueSize: number;
  /** Items handed to one `exportBatch` call. */
  readonly maxBatchSize: number;
  /** How often the queue checks for work to send. */
  readonly scheduledDelayMs: number;
  /** First retry delay after a failed export; doubled per consecutive failure up to `maxBackoffMs`. */
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Sends one batch and calls `done(true)` on success or `done(false)` on failure. */
  readonly exportBatch: (batch: T[], done: (ok: boolean) => void) => void;
  readonly onDropped: (count: number) => void;
  readonly onExportError: () => void;
}

/**
 * A bounded, in-memory export buffer that drops the oldest items when full (OBS-001 edge case). A failed
 * batch goes back to the head of the queue and is retried after an exponential backoff, so a collector
 * that is down at boot is retried until it answers, while the app keeps running. The timer is unref'd and
 * the queue never blocks its caller.
 */
export class DropOldestExportQueue<T> {
  private readonly items: T[] = [];
  private backoffMs: number;
  private nextAttemptAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(private readonly options: ExportQueueOptions<T>) {
    this.backoffMs = options.baseBackoffMs;
  }

  /** Starts the periodic sender. Idempotent. */
  start(): void {
    if (this.timer !== undefined || this.closed) return;
    this.timer = setInterval(() => {
      if (Date.now() >= this.nextAttemptAt) void this.sendAll();
    }, this.options.scheduledDelayMs);
    this.timer.unref();
  }

  /** Buffers one item, dropping the oldest buffered item when the queue is full. */
  enqueue(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.trim();
  }

  /** Sends everything buffered, stopping at the first failed batch. Resolves when no batch is left to send now. */
  async forceFlush(): Promise<void> {
    while (this.items.length > 0) {
      const ok = await this.sendBatch();
      if (!ok) return;
    }
  }

  /** Flushes once more, then stops the timer and refuses new items. */
  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Items currently buffered (test and self-metric use). */
  get size(): number {
    return this.items.length;
  }

  private async sendAll(): Promise<void> {
    while (this.items.length > 0 && Date.now() >= this.nextAttemptAt) {
      const ok = await this.sendBatch();
      if (!ok) return;
    }
  }

  private sendBatch(): Promise<boolean> {
    const batch = this.items.splice(0, this.options.maxBatchSize);
    if (batch.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        if (ok) {
          this.backoffMs = this.options.baseBackoffMs;
          this.nextAttemptAt = 0;
        } else {
          this.onFailure(batch);
        }
        resolve(ok);
      };
      try {
        this.options.exportBatch(batch, done);
      } catch {
        done(false);
      }
    });
  }

  private onFailure(batch: T[]): void {
    this.options.onExportError();
    this.items.unshift(...batch);
    this.trim();
    this.nextAttemptAt = Date.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs);
  }

  private trim(): void {
    const overflow = this.items.length - this.options.maxQueueSize;
    if (overflow > 0) {
      this.items.splice(0, overflow);
      this.options.onDropped(overflow);
    }
  }
}
