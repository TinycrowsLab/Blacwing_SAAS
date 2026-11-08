import type { Gate2Status, HuntRun, HuntStore, RunEvent } from './types.js';

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
  /** Resolves a target host before each send (private-range guard). Defaults to `dns.lookup(host, { all: true })`. */
  readonly lookup?: (hostname: string) => Promise<readonly { readonly address: string }[]>;
}

/** One recorded test case. `status` is the model's own word until the run ends; coverage derives the final one. */
export interface CaseState {
  readonly title: string;
  readonly agent: string;
  /** The endpoint the planner named for it. */
  readonly target?: string;
  status: string;
  note: string | null;
  /** Requests actually sent with this case_id, and candidates submitted for it. */
  requests: number;
  candidates: number;
}

/** One Gate 2 ask of this run. The watcher (http-tool `watchGate2`) moves it out of `pending`. */
export interface Gate2Ask {
  readonly id: string;
  /** `gateKey(method, url, role)`: what an approval covers. */
  readonly key: string;
  /** "POST /api/Users as no test account", for notices. */
  readonly label: string;
  readonly agent: string;
  /** The test case the ask was raised for, when the agent named one. */
  readonly caseId: string | null;
  readonly deadlineAt: number;
  status: Gate2Status;
  /** Set when the run closed the ask itself (no person answered before it ended). */
  closedUnanswered?: boolean;
  /** Set once the approved request went out. */
  sent?: boolean;
}

/** Runner-owned case status: the model's skip, block or decline stands (with its note); otherwise only sent requests or candidates count. */
export function caseOutcome(testCase: CaseState): 'executed' | 'skipped' | 'blocked' | 'model_declined' | 'not_run' {
  if (testCase.status === 'skipped' || testCase.status === 'blocked' || testCase.status === 'model_declined') return testCase.status;
  return testCase.requests > 0 || testCase.candidates > 0 ? 'executed' : 'not_run';
}

export interface HuntState {
  requestsUsed: number;
  exchangeSeq: number;
  paused: boolean;
  findings: number;
  /** Test case id -> case, from record_test_cases / update_test_case. */
  readonly cases: Map<string, CaseState>;
  /** Gate 2 asks by id; an approved ask covers its key for the rest of the run, a denied or expired one is never asked again. */
  readonly asks: Map<string, Gate2Ask>;
  /** Agent -> Gate 2 outcomes not yet shown to it; prepended to its next tool result. */
  readonly notices: Map<string, { readonly gate2Id: string; readonly text: string }[]>;
  /** Requests actually sent as each test account role. */
  readonly roleCounts: Map<string, number>;
  /** The `accounts.unused` warning was emitted (once per run). */
  accountsWarned: boolean;
}

export function newHuntState(): HuntState {
  return { requestsUsed: 0, exchangeSeq: 0, paused: false, findings: 0, cases: new Map(), asks: new Map(), notices: new Map(), roleCounts: new Map(), accountsWarned: false };
}

/** Everything the tools of one run share. `state` is the only mutable part. */
export interface HuntContext {
  readonly run: HuntRun;
  readonly store: HuntStore;
  readonly log: EventLog;
  readonly signal: AbortSignal;
  readonly deps: HuntDeps;
  readonly state: HuntState;
}
