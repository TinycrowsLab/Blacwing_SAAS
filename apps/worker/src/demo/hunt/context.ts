import type { HuntRun, HuntStore, RunEvent } from './types.js';

export interface Logger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Appends events for one run in emit order: writes are chained, the store allocates each seq. */
export class EventLog {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HuntStore,
    private readonly runId: string,
    private readonly logger: Logger,
  ) {}

  emit(kind: string, stage: string, message: string, data: Record<string, unknown>): Promise<void> {
    const event: RunEvent = { kind, stage, message, data };
    this.chain = this.chain
      .then(() => this.store.appendEvent(this.runId, event))
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
  /** Optional Slack-compatible webhook; null means released findings are not delivered. */
  readonly webhookUrl: string | null;
  readonly consoleOrigin: string;
}

/** Everything the tools of one run share. `state` is the only mutable part. */
export interface HuntContext {
  readonly run: HuntRun;
  readonly store: HuntStore;
  readonly log: EventLog;
  readonly signal: AbortSignal;
  readonly deps: HuntDeps;
  readonly state: {
    requestsUsed: number;
    exchangeSeq: number;
    paused: boolean;
    findings: number;
    readonly approved: Set<string>;
    /** Test case id -> status, from record_test_cases / update_test_case. */
    readonly cases: Map<string, string>;
  };
}
