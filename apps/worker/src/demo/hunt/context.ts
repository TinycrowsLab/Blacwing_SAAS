import type { HuntRun, HuntStore, RunEvent } from './types.js';

export interface Logger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Appends events for one run in order: seq numbers are taken synchronously, writes are chained. */
export class EventLog {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HuntStore,
    private readonly runId: string,
    private nextSeq: number,
    private readonly logger: Logger,
  ) {}

  emit(kind: string, stage: string, message: string, data: Record<string, unknown>): Promise<void> {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const event: RunEvent = { kind, stage, message, data };
    this.chain = this.chain
      .then(() => this.store.appendEvent(this.runId, seq, event))
      .catch((error: unknown) => {
        this.logger.warn({ event: 'demo.hunt.event_failed', kind, reason: error instanceof Error ? error.name : 'unknown' }, 'event append failed');
      });
    return this.chain;
  }
}

export interface HuntDeps {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly gate2TimeoutMs: number;
}

/** Everything the tools of one run share. `state` is the only mutable part. */
export interface HuntContext {
  readonly run: HuntRun;
  readonly store: HuntStore;
  readonly log: EventLog;
  readonly signal: AbortSignal;
  readonly deps: HuntDeps;
  readonly state: { requestsUsed: number; exchangeSeq: number; paused: boolean; findings: number; readonly approved: Set<string> };
}
