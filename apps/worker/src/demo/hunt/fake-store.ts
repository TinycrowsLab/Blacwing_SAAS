// In-memory HuntStore for unit tests and the live smoke script. Not used by the product.
import type { ShotResult } from './screenshot.js';
import type {
  ExchangeRow,
  FindingRow,
  Gate2CloseReason,
  Gate2Row,
  Gate2Status,
  HuntRun,
  HuntStore,
  ResumeState,
  RetestJob,
  RetestResult,
  RunControl,
  RunEvent,
  RunOutcome,
  StaleRun,
  SummaryFinding,
} from './types.js';

const FAKE_KILL_HALT_MS = 5;

export class FakeStore implements HuntStore {
  readonly events: RunEvent[] = [];
  readonly exchanges: ExchangeRow[] = [];
  readonly gate2 = new Map<
    string,
    { row: Gate2Row; status: Gate2Status; decidedBy: string | null; closeReason?: string }
  >();
  /** Ledger entries the worker wrote (gate2.expired). */
  readonly ledger: { action: string; targetId: string; payload: Record<string, unknown> }[] = [];
  readonly findings: FindingRow[] = [];
  readonly screenshots: { findingId: string; result: ShotResult }[] = [];
  readonly deliveries: { findingId: string; status: string; detail: string }[] = [];
  control: RunControl = { paused: false, kill: null };
  finished: RunOutcome | null = null;
  killedHaltMs: number | null = null;
  progress: { requestsUsed: number; costUsd: number } | null = null;

  /** Set by a test to make the next claimed run resume from this state; null (the default) is a fresh run. */
  resumeState: ResumeState | null = null;
  claimQueuedRun(): Promise<HuntRun | null> {
    return Promise.resolve(null);
  }
  loadResumeState(): Promise<ResumeState | null> {
    return Promise.resolve(this.resumeState);
  }
  failStaleRuns(): Promise<StaleRun[]> {
    return Promise.resolve([]);
  }
  appendEvent(_runId: string, event: RunEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
  readControl(): Promise<RunControl> {
    return Promise.resolve(this.control);
  }
  insertExchange(_run: HuntRun, row: ExchangeRow): Promise<void> {
    this.exchanges.push(row);
    return Promise.resolve();
  }
  listExchanges(): Promise<
    { method: string; url: string; status: number | null; bytes: number }[]
  > {
    return Promise.resolve(
      this.exchanges
        .filter((e) => e.outcome === 'sent')
        .map((e) => ({
          method: e.method,
          url: e.url,
          status: e.status,
          bytes: e.responseBody?.length ?? 0,
        })),
    );
  }
  insertGate2(_run: HuntRun, row: Gate2Row): Promise<void> {
    this.gate2.set(row.id, { row, status: 'pending', decidedBy: null });
    return Promise.resolve();
  }
  readGate2(id: string): Promise<{ status: Gate2Status; decidedBy: string | null }> {
    const entry = this.gate2.get(id);
    return Promise.resolve({
      status: entry?.status ?? 'denied',
      decidedBy: entry?.decidedBy ?? null,
    });
  }
  closeGate2(
    id: string,
    status: 'denied' | 'expired',
    reason: Gate2CloseReason,
  ): Promise<Gate2Status> {
    const entry = this.gate2.get(id);
    if (entry?.status === 'pending') {
      entry.status = status;
      entry.closeReason = reason;
      if (status === 'expired') {
        const { row } = entry;
        this.ledger.push({
          action: 'gate2.expired',
          targetId: id,
          payload: {
            method: row.method,
            url: row.url.split(/[?#]/, 1)[0] ?? '',
            reason,
            deadlineAt: row.deadlineAt.toISOString(),
          },
        });
      }
    }
    return Promise.resolve(entry?.status ?? status);
  }
  async closePendingGate2(_runId: string, reason: 'run_ended' | 'killed'): Promise<string[]> {
    const ids: string[] = [];
    for (const [id, entry] of this.gate2)
      if (
        entry.status === 'pending' &&
        (await this.closeGate2(id, 'expired', reason)) === 'expired'
      )
        ids.push(id);
    return ids;
  }
  listFindingsForSummary(): Promise<SummaryFinding[]> {
    return Promise.resolve(
      this.findings.map((f) => ({
        title: f.title,
        severity: f.severity,
        cwe: f.cwe,
        owasp: f.owasp,
        status: f.status,
        location:
          `${typeof f.location.method === 'string' ? f.location.method : ''} ${typeof f.location.url === 'string' ? f.location.url : ''}`.trim(),
        remediation: null,
      })),
    );
  }
  saveScreenshots(_run: HuntRun, findingId: string, result: ShotResult): Promise<void> {
    this.screenshots.push({ findingId, result });
    return Promise.resolve();
  }
  insertFinding(_run: HuntRun, row: FindingRow): Promise<string | null> {
    const existing = this.findings.findIndex((f) => f.fingerprint === row.fingerprint);
    if (existing >= 0) {
      const old = this.findings[existing];
      if (row.status === 'suspected') return Promise.resolve(old?.id ?? null);
      if (old?.status !== 'suspected') return Promise.resolve(null);
      this.findings[existing] = { ...row, id: old.id };
      return Promise.resolve(old.id);
    }
    this.findings.push(row);
    return Promise.resolve(row.id);
  }
  findingByFingerprint(
    _run: HuntRun,
    fingerprint: string,
  ): Promise<{ id: string; title: string } | null> {
    const found = this.findings.find((f) => f.fingerprint === fingerprint);
    return Promise.resolve(found === undefined ? null : { id: found.id, title: found.title });
  }
  supersedeCopies(_run: HuntRun, findingId: string, identityKey: string): Promise<string[]> {
    // The fake keeps no dismissed rows: a superseded copy leaves the list and goes on the ledger.
    const ids = this.findings
      .filter(
        (f) => f.identityKey === identityKey && f.id !== findingId && f.status === 'confirmed',
      )
      .map((f) => f.id);
    for (const id of ids) {
      this.findings.splice(
        this.findings.findIndex((f) => f.id === id),
        1,
      );
      this.ledger.push({ action: 'finding.superseded', targetId: id, payload: { by: findingId } });
    }
    return Promise.resolve(ids);
  }
  recordDelivery(findingId: string, status: 'delivered' | 'failed', detail: string): Promise<void> {
    this.deliveries.push({ findingId, status, detail });
    return Promise.resolve();
  }
  saveProgress(_runId: string, requestsUsed: number, costUsd: number): Promise<void> {
    this.progress = { requestsUsed, costUsd };
    return Promise.resolve();
  }
  finishRun(_run: HuntRun, outcome: RunOutcome): Promise<void> {
    this.finished = outcome;
    return Promise.resolve();
  }
  markKilled(): Promise<number> {
    this.killedHaltMs = FAKE_KILL_HALT_MS;
    return Promise.resolve(FAKE_KILL_HALT_MS);
  }
  readonly retests: RetestJob[] = [];
  readonly retestResults = new Map<string, RetestResult>();
  claimQueuedRetest(): Promise<RetestJob | null> {
    return Promise.resolve(this.retests.shift() ?? null);
  }
  finishRetest(id: string, result: RetestResult): Promise<void> {
    this.retestResults.set(id, result);
    return Promise.resolve();
  }
}
