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
}

export type Gate2Status = 'pending' | 'approved' | 'denied' | 'expired';

export interface FindingRow {
  readonly id: string;
  readonly fingerprint: string;
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

/** Persistence the hunt needs. Implemented over `pg` in ../store-pg.ts, faked in unit tests. */
export interface HuntStore {
  claimQueuedRun(): Promise<HuntRun | null>;
  /** Marks runs left `running` by a dead worker as failed and denies their pending Gate 2 requests. */
  failStaleRuns(): Promise<StaleRun[]>;
  nextSeq(runId: string): Promise<number>;
  appendEvent(runId: string, seq: number, event: RunEvent): Promise<void>;
  readControl(runId: string): Promise<RunControl>;
  insertExchange(run: HuntRun, row: ExchangeRow): Promise<void>;
  listExchanges(runId: string, limit: number): Promise<{ method: string; url: string; status: number | null; bytes: number }[]>;
  insertGate2(run: HuntRun, row: Gate2Row): Promise<void>;
  readGate2(id: string): Promise<{ status: Gate2Status; decidedBy: string | null }>;
  /** Moves a still-pending request to `status`; returns the status it ends with. */
  closeGate2(id: string, status: 'denied' | 'expired'): Promise<Gate2Status>;
  denyPendingGate2(runId: string): Promise<string[]>;
  /** Returns false when the fingerprint already exists. */
  insertFinding(run: HuntRun, row: FindingRow): Promise<boolean>;
  saveProgress(runId: string, requestsUsed: number, costUsd: number): Promise<void>;
  finishRun(run: HuntRun, outcome: RunOutcome): Promise<void>;
  /** Sets state=killed, killed_at=now and halt_ms from kill_requested_at; returns halt_ms. */
  markKilled(run: HuntRun): Promise<number>;
}
