// In-memory HuntStore for unit tests and the live smoke script. Not used by the product.
import type { ExchangeRow, FindingRow, Gate2Row, Gate2Status, HuntRun, HuntStore, RunControl, RunEvent, RunOutcome, StaleRun } from './types.js';

const FAKE_KILL_HALT_MS = 5;

export class FakeStore implements HuntStore {
  readonly events: RunEvent[] = [];
  readonly exchanges: ExchangeRow[] = [];
  readonly gate2 = new Map<string, { row: Gate2Row; status: Gate2Status; decidedBy: string | null }>();
  readonly findings: FindingRow[] = [];
  control: RunControl = { paused: false, kill: null };
  finished: RunOutcome | null = null;
  killedHaltMs: number | null = null;
  progress: { requestsUsed: number; costUsd: number } | null = null;

  claimQueuedRun(): Promise<HuntRun | null> {
    return Promise.resolve(null);
  }
  failStaleRuns(): Promise<StaleRun[]> {
    return Promise.resolve([]);
  }
  nextSeq(): Promise<number> {
    return Promise.resolve(this.events.length + 1);
  }
  appendEvent(_runId: string, _seq: number, event: RunEvent): Promise<void> {
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
  listExchanges(): Promise<{ method: string; url: string; status: number | null; bytes: number }[]> {
    return Promise.resolve(this.exchanges.filter((e) => e.outcome === 'sent').map((e) => ({ method: e.method, url: e.url, status: e.status, bytes: e.responseBody?.length ?? 0 })));
  }
  insertGate2(_run: HuntRun, row: Gate2Row): Promise<void> {
    this.gate2.set(row.id, { row, status: 'pending', decidedBy: null });
    return Promise.resolve();
  }
  readGate2(id: string): Promise<{ status: Gate2Status; decidedBy: string | null }> {
    const entry = this.gate2.get(id);
    return Promise.resolve({ status: entry?.status ?? 'denied', decidedBy: entry?.decidedBy ?? null });
  }
  closeGate2(id: string, status: 'denied' | 'expired'): Promise<Gate2Status> {
    const entry = this.gate2.get(id);
    if (entry?.status === 'pending') entry.status = status;
    return Promise.resolve(entry?.status ?? status);
  }
  denyPendingGate2(): Promise<string[]> {
    const ids: string[] = [];
    for (const [id, entry] of this.gate2) {
      if (entry.status === 'pending') {
        entry.status = 'denied';
        ids.push(id);
      }
    }
    return Promise.resolve(ids);
  }
  insertFinding(_run: HuntRun, row: FindingRow): Promise<boolean> {
    if (this.findings.some((f) => f.fingerprint === row.fingerprint)) return Promise.resolve(false);
    this.findings.push(row);
    return Promise.resolve(true);
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
}
