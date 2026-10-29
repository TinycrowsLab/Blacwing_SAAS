// DEMO-STORY runner persistence over `pg` (demo schema only, see migration 20261029200000_demo_story_schema).
import type { ReplayPins, StageEvent } from './replay.js';
import type { FindingInsert, QueuedRun, RunnerStore } from './runner.js';
import type pg from 'pg';

/** Claims the oldest queued run in one statement; SKIP LOCKED lets several runners poll safely. */
const CLAIM_SQL = `
  UPDATE demo.runs SET state = 'running', started_at = now()
  WHERE id = (
    SELECT id FROM demo.runs WHERE state = 'queued' ORDER BY created_at
    FOR UPDATE SKIP LOCKED LIMIT 1
  )
  RETURNING id, tenant_id, request_id, pins, budget_requests`;

export function pgRunnerStore(pool: pg.Pool): RunnerStore {
  return {
    async claimQueuedRun(): Promise<QueuedRun | null> {
      const r = await pool.query<{ id: string; tenant_id: string; request_id: string; pins: ReplayPins; budget_requests: number }>(CLAIM_SQL);
      const row = r.rows[0];
      if (row === undefined) return null;
      return { id: row.id, tenant_id: row.tenant_id, request_id: row.request_id, pins: row.pins, budget_requests: row.budget_requests };
    },
    async nextSeq(runId: string): Promise<number> {
      const r = await pool.query<{ next: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM demo.run_events WHERE run_id = $1', [runId]);
      return r.rows[0]?.next ?? 1;
    },
    async appendEvent(runId: string, seq: number, event: StageEvent): Promise<void> {
      await pool.query(
        'INSERT INTO demo.run_events (run_id, seq, kind, stage, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
        [runId, seq, event.kind, event.stage, event.message, JSON.stringify(event.data)],
      );
    },
    async insertFinding(row: FindingInsert): Promise<void> {
      await pool.query(
        `INSERT INTO demo.findings (id, tenant_id, run_id, asset_id, fingerprint, title, test_case_id, class,
           cwe_id, owasp_category, severity, location, status, confidence, oracle, evidence, replay, repro_curl)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'confirmed', $13, $14, $15, $16, $17)
         ON CONFLICT (tenant_id, fingerprint) DO NOTHING`,
        [
          row.id, row.tenant_id, row.run_id, row.asset_id, row.fingerprint, row.title, row.test_case_id, row.class,
          row.cwe_id, row.owasp_category, JSON.stringify(row.severity), JSON.stringify(row.location), row.confidence,
          JSON.stringify(row.oracle), JSON.stringify(row.evidence), JSON.stringify(row.replay), row.repro_curl,
        ],
      );
    },
    async finishRun(runId: string, state: 'completed' | 'failed', requestsUsed: number): Promise<void> {
      await pool.query('UPDATE demo.runs SET state = $2, requests_used = $3, finished_at = now() WHERE id = $1', [runId, state, requestsUsed]);
    },
    async setRequestStatus(tenantId: string, requestId: string, status: 'completed' | 'approved'): Promise<void> {
      await pool.query('UPDATE demo.assessment_requests SET status = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, requestId, status]);
    },
  };
}
