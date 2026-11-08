import type { Scope } from './scope.js';

export interface HuntRun {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly assetId: string;
  readonly assetName: string;
  readonly objective: string;
  readonly scope: Scope;
  readonly budgetRequests: number;
  readonly budgetSeconds: number;
  readonly costCapUsd: number;
  /** The request's ceiling: passive allows only GET, HEAD and OPTIONS. */
  readonly intrusiveness: 'passive' | 'active_safe';
  /** Grey-box credentials. The header value stays inside the runner: the model only names the role. */
  readonly testAccounts: readonly { readonly role: string; readonly headerName: string; readonly headerValue: string }[];
  /** Gate 3 mode chosen on the plan: `hold` keeps proven findings for a human release, `auto` releases them at once. */
  readonly releaseProven: 'hold' | 'auto';
  /** Allowed origins the operator listed as labs (pins.asset.labOrigins): private addresses are allowed only there. */
  readonly labOrigins: readonly string[];
}

export interface RunEvent {
  readonly kind: string;
  readonly stage: string;
  readonly message: string;
  readonly data: Record<string, unknown>;
}

export interface ExchangeRow {
  readonly id: string;
  readonly seq: number;
  readonly agent: string;
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Record<string, string>;
  readonly requestBody: string | null;
  readonly status: number | null;
  readonly responseHeaders: Record<string, string> | null;
  readonly responseBody: string | null;
  readonly durationMs: number | null;
  readonly outcome: 'sent' | 'blocked' | 'denied' | 'error';
  readonly reason: string | null;
}

export interface Gate2Row {
  readonly id: string;
  readonly agent: string;
  readonly method: string;
  readonly url: string;
  readonly pathKey: string;
  readonly reason: string;
  readonly whyOutside: string;
  readonly deadlineAt: Date;
  /** The request body as it would be sent (scrubbed), shown on the Gate 2 card. */
  readonly body: string | null;
  readonly asRole: string | null;
}

export type Gate2Status = 'pending' | 'approved' | 'denied' | 'expired';
export type Gate2CloseReason = 'deadline' | 'run_ended' | 'killed' | 'worker_restarted';

export interface FindingRow {
  readonly id: string;
  readonly fingerprint: string;
  /** sha256(asset | METHOD | normalised path | CWE): the same issue across runs and agents. */
  readonly identityKey: string | null;
  readonly agent: string;
  readonly title: string;
  readonly vulnClass: string;
  readonly cwe: string;
  readonly owasp: string;
  readonly severity: string;
  readonly description: string;
  readonly location: Record<string, unknown>;
  readonly oracle: Record<string, unknown>;
  readonly evidence: Record<string, unknown>;
  readonly replay: Record<string, unknown>;
  readonly reproCurl: string;
  /** Validator-proven: `released` (auto release) or `confirmed` (waits for a human release). `suspected`: not proven, analysts only. */
  readonly status: 'released' | 'confirmed' | 'suspected';
  readonly testCaseId: string | null;
}

export interface RunControl {
  readonly paused: boolean;
  /** Set once a human asked to kill the run. */
  readonly kill: { readonly by: string | null } | null;
}

export interface RunOutcome {
  readonly state: 'completed' | 'failed';
  readonly requestsUsed: number;
  readonly costUsd: number;
  readonly summary: string | null;
}

export interface StaleRun {
  readonly id: string;
  readonly requestsUsed: number;
  readonly costUsd: number;
  readonly findings: number;
}

/** A queued retest of one finding, with a run rebuilt from the finding's run pins (budget: probe replays + control). */
export interface RetestJob {
  readonly id: string;
  readonly findingId: string;
  readonly run: HuntRun;
  /** `evidence.probe.request` / `evidence.control.request` as stored (scrubbed SentRequest), or absent on old rows. */
  readonly probe: unknown;
  readonly control: unknown;
  readonly oracle: unknown;
}

export type RetestOutcome = 'still_present' | 'fixed' | 'inconclusive';

export interface RetestResult {
  readonly status: 'done' | 'failed';
  readonly result: RetestOutcome | null;
  readonly detail: Record<string, unknown>;
}

/** Persistence the hunt needs. Implemented over `pg` in ../store-pg.ts, faked in unit tests. */
export interface HuntStore {
  claimQueuedRun(): Promise<HuntRun | null>;
  /** Marks runs (and retests) left `running` by a dead worker as failed and denies their pending Gate 2 requests. */
  failStaleRuns(): Promise<StaleRun[]>;
  /** Allocates the next seq itself: the API appends events to the same run. */
  appendEvent(runId: string, event: RunEvent): Promise<void>;
  readControl(runId: string): Promise<RunControl>;
  insertExchange(run: HuntRun, row: ExchangeRow): Promise<void>;
  listExchanges(runId: string, limit: number): Promise<{ method: string; url: string; status: number | null; bytes: number }[]>;
  insertGate2(run: HuntRun, row: Gate2Row): Promise<void>;
  readGate2(id: string): Promise<{ status: Gate2Status; decidedBy: string | null }>;
  /** Moves a still-pending request to `status` with `reason`; returns the status it ends with. An expiry is ledgered. */
  closeGate2(id: string, status: 'denied' | 'expired', reason: Gate2CloseReason): Promise<Gate2Status>;
  /** Closes every pending request of the run as `expired` (no person answered; `close_reason` = reason), each ledgered; returns their ids. */
  closePendingGate2(runId: string, reason: 'run_ended' | 'killed'): Promise<string[]>;
  /** Returns the id of the inserted row (a proven row also upgrades a suspected one); a suspected copy returns the stored row's id; null for a proven duplicate. */
  insertFinding(run: HuntRun, row: FindingRow): Promise<string | null>;
  /**
   * Older copies of one issue (same asset and identity key) still awaiting Gate 3 are dismissed as superseded by the
   * newer proof `findingId`, each on the ledger; returns their ids. Nothing is released: the newest copy still waits.
   */
  supersedeCopies(run: HuntRun, findingId: string, identityKey: string): Promise<string[]>;
  /** Records the result of the webhook POST for a released finding. */
  recordDelivery(findingId: string, status: 'delivered' | 'failed', detail: string): Promise<void>;
  saveProgress(runId: string, requestsUsed: number, costUsd: number): Promise<void>;
  finishRun(run: HuntRun, outcome: RunOutcome): Promise<void>;
  /** Sets state=killed, killed_at=now and halt_ms from kill_requested_at; returns halt_ms. */
  markKilled(run: HuntRun): Promise<number>;
  /** Claims the oldest queued finding retest (SKIP LOCKED), or null. */
  claimQueuedRetest(): Promise<RetestJob | null>;
  finishRetest(id: string, result: RetestResult): Promise<void>;
}
