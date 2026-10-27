import type { ReconSessionOutcome } from './types.js';
import type { RunBudget, RunMode, RunState } from '@blackwing/contracts';

/**
 * Ports the recon activities depend on. Tenant data access (`runs`), the surface store (Postgres +
 * Neo4j, GRAPH) and the audit ledger own the real adapters; each is a seam here so the phase is testable
 * and fails closed. A port that throws means "could not answer": the activity is retried.
 */

/** What the phase needs to know about the run, loaded tenant-scoped (RLS). */
export interface ReconRunFacts {
  readonly runId: string;
  readonly tenantId: string;
  readonly state: RunState;
  readonly mode: RunMode;
  /** `runs.budgets`: the recon slice is cut from this. */
  readonly budgets: RunBudget;
  /** Grey/white: an input manifest (spec, source, HAR) was supplied and supplies the surface (§3.2). */
  readonly manifestSuppliesSurface: boolean;
}

export interface ReconRunRepo {
  /** `null` when the run does not exist for this tenant (RLS hides other tenants' runs). */
  load(tenantId: string, runId: string): Promise<ReconRunFacts | null>;
}

/** Counts of the surface model for a run. The surface is untrusted data; this only counts nodes. */
export interface SurfaceCounts {
  readonly hosts: number;
  readonly endpoints: number;
}

export interface SurfaceReader {
  /** Reads the finalised surface model of the run. Rejects when Postgres or Neo4j cannot answer. */
  count(tenantId: string, runId: string): Promise<SurfaceCounts>;
}

/** An audit record before the ledger assigns its sequence number and hash (AUDIT-002). */
export interface ReconAuditRecord {
  readonly action:
    'recon.started' | 'recon.session.started' | 'recon.session.finished' | 'recon.completed';
  readonly outcome: 'success' | 'failure';
  readonly tenantId: string;
  readonly runId: string;
  readonly occurredAt: string;
  /** Stable per run and event, so a retried activity cannot append a duplicate. */
  readonly dedupeKey: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** Append-only audit writer (§8.8). A failure must surface so Temporal retries the activity. */
export interface ReconAuditSink {
  append(record: ReconAuditRecord): Promise<void>;
}

/** Metrics sink; the default implementation is OpenTelemetry. */
export interface ReconMetrics {
  /** `blackwing_recon_sessions_total{persona,mode,status}`. */
  session(persona: string, mode: RunMode, status: ReconSessionOutcome): void;
  /** `blackwing_recon_duration_seconds`. */
  duration(seconds: number): void;
}
