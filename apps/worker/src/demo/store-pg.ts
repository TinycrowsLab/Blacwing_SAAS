// Hunt persistence over `pg` (demo schema, see migration 20261105000000_demo_ai_hunt).
import { z } from 'zod';

import type { ExchangeRow, FindingRow, Gate2Row, Gate2Status, HuntRun, HuntStore, RunControl, RunEvent, RunOutcome, StaleRun } from './hunt/types.js';
import type pg from 'pg';

const pinsSchema = z.object({
  asset: z.object({ id: z.string(), name: z.string(), allowedOrigins: z.array(z.string()), excludedPaths: z.array(z.string()) }),
  request: z.object({
    id: z.string(),
    objective: z.string(),
    budget: z.object({ requests: z.number(), seconds: z.number(), costUsd: z.number() }),
    intrusiveness: z.enum(['passive', 'active_safe']).default('active_safe'),
  }),
});

const testAccountsSchema = z.array(z.object({ role: z.string(), header_name: z.string(), header_value: z.string() })).default([]);

interface ClaimedRow {
  id: string;
  tenant_id: string;
  request_id: string;
  pins: unknown;
  test_accounts: unknown;
}

const UNIQUE_VIOLATION = '23505';
const EVENT_APPEND_ATTEMPTS = 5;
const AUTO_RELEASE_REASON = 'Auto-released: proven by deterministic replay.';

/** Claims the oldest queued run in one statement; SKIP LOCKED lets several workers poll safely. */
const CLAIM_SQL = `
  UPDATE demo.runs SET state = 'running', started_at = now()
  WHERE id = (
    SELECT id FROM demo.runs WHERE state = 'queued' ORDER BY created_at
    FOR UPDATE SKIP LOCKED LIMIT 1
  )
  RETURNING id, tenant_id, request_id, pins,
    (SELECT test_accounts FROM demo.assessment_requests q WHERE q.id = demo.runs.request_id) AS test_accounts`;

export function pgHuntStore(pool: pg.Pool): HuntStore {
  const gate2Status = async (id: string): Promise<{ status: Gate2Status; decidedBy: string | null }> => {
    const r = await pool.query<{ status: Gate2Status; decided_by: string | null }>('SELECT status, decided_by FROM demo.gate2_requests WHERE id = $1', [id]);
    const row = r.rows[0];
    return { status: row?.status ?? 'denied', decidedBy: row?.decided_by ?? null };
  };

  return {
    async claimQueuedRun(): Promise<HuntRun | null> {
      const r = await pool.query<ClaimedRow>(CLAIM_SQL);
      const row = r.rows[0];
      if (row === undefined) return null;
      const pins = pinsSchema.parse(row.pins);
      return {
        id: row.id,
        tenantId: row.tenant_id,
        requestId: row.request_id,
        assetId: pins.asset.id,
        assetName: pins.asset.name,
        objective: pins.request.objective,
        scope: { allowedOrigins: pins.asset.allowedOrigins, excludedPaths: pins.asset.excludedPaths },
        budgetRequests: pins.request.budget.requests,
        budgetSeconds: pins.request.budget.seconds,
        costCapUsd: pins.request.budget.costUsd,
        intrusiveness: pins.request.intrusiveness,
        testAccounts: testAccountsSchema.parse(row.test_accounts).map((a) => ({ role: a.role, headerName: a.header_name, headerValue: a.header_value })),
      };
    },
    async failStaleRuns(): Promise<StaleRun[]> {
      const r = await pool.query<{ id: string; request_id: string; requests_used: number; cost_usd: string; findings: number }>(
        `UPDATE demo.runs r SET state = 'failed', finished_at = now() WHERE state IN ('running', 'paused')
         RETURNING id, request_id, requests_used, cost_usd,
           (SELECT count(*)::int FROM demo.findings f WHERE f.run_id = r.id AND f.status IN ('confirmed', 'released')) AS findings`,
      );
      const ids = r.rows.map((row) => row.id);
      await pool.query("UPDATE demo.gate2_requests SET status = 'denied', decided_at = now() WHERE run_id = ANY($1) AND status = 'pending'", [ids]);
      await pool.query("UPDATE demo.assessment_requests SET status = 'approved' WHERE id = ANY($1)", [r.rows.map((row) => row.request_id)]);
      return r.rows.map((row) => ({ id: row.id, requestsUsed: row.requests_used, costUsd: Number(row.cost_usd), findings: row.findings }));
    },
    /** The API appends events to the same run, so the seq is computed in SQL; a lost race is retried. */
    async appendEvent(runId: string, event: RunEvent): Promise<void> {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await pool.query(
            `INSERT INTO demo.run_events (run_id, seq, kind, stage, message, data)
             SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM demo.run_events WHERE run_id = $1`,
            [runId, event.kind, event.stage, event.message, JSON.stringify(event.data)],
          );
          return;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== UNIQUE_VIOLATION || attempt >= EVENT_APPEND_ATTEMPTS) throw error;
        }
      }
    },
    async readControl(runId: string): Promise<RunControl> {
      const r = await pool.query<{ paused: boolean; kill_requested_at: Date | null; kill_requested_by: string | null }>(
        'SELECT paused, kill_requested_at, kill_requested_by FROM demo.runs WHERE id = $1',
        [runId],
      );
      const row = r.rows[0];
      return { paused: row?.paused ?? false, kill: row?.kill_requested_at === null || row?.kill_requested_at === undefined ? null : { by: row.kill_requested_by } };
    },
    async insertExchange(run: HuntRun, row: ExchangeRow): Promise<void> {
      await pool.query(
        `INSERT INTO demo.http_exchanges (id, tenant_id, run_id, seq, agent, method, url, request_headers, request_body, status,
           response_headers, response_body, duration_ms, outcome, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          row.id, run.tenantId, run.id, row.seq, row.agent, row.method, row.url, JSON.stringify(row.requestHeaders), row.requestBody,
          row.status, row.responseHeaders === null ? null : JSON.stringify(row.responseHeaders), row.responseBody, row.durationMs,
          row.outcome, row.reason,
        ],
      );
    },
    async listExchanges(runId: string, limit: number) {
      const r = await pool.query<{ method: string; url: string; status: number | null; bytes: number }>(
        "SELECT method, url, status, COALESCE(length(response_body), 0) AS bytes FROM demo.http_exchanges WHERE run_id = $1 AND outcome = 'sent' ORDER BY seq DESC LIMIT $2",
        [runId, limit],
      );
      return r.rows;
    },
    async insertGate2(run: HuntRun, row: Gate2Row): Promise<void> {
      await pool.query(
        `INSERT INTO demo.gate2_requests (id, tenant_id, run_id, agent, method, url, path_key, intrusiveness, reason, why_outside, deadline_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'state_changing', $8, $9, $10)`,
        [row.id, run.tenantId, run.id, row.agent, row.method, row.url, row.pathKey, row.reason, row.whyOutside, row.deadlineAt],
      );
    },
    readGate2: gate2Status,
    async closeGate2(id: string, status: 'denied' | 'expired'): Promise<Gate2Status> {
      await pool.query("UPDATE demo.gate2_requests SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending'", [id, status]);
      return (await gate2Status(id)).status;
    },
    async denyPendingGate2(runId: string): Promise<string[]> {
      const r = await pool.query<{ id: string }>("UPDATE demo.gate2_requests SET status = 'denied', decided_at = now() WHERE run_id = $1 AND status = 'pending' RETURNING id", [runId]);
      return r.rows.map((row) => row.id);
    },
    async insertFinding(run: HuntRun, row: FindingRow): Promise<string | null> {
      const released = row.status === 'released';
      const r = await pool.query<{ id: string }>(
        `INSERT INTO demo.findings (id, tenant_id, run_id, asset_id, fingerprint, title, test_case_id, class, cwe_id, owasp_category,
           severity, location, status, confidence, oracle, evidence, replay, repro_curl, agent, description, triaged_at, triage_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $15, $16, $17, $18, $19,
           CASE WHEN $13::text = 'released' THEN now() END, CASE WHEN $13::text = 'released' THEN $20::text END)
         ${
           released
             ? `ON CONFLICT (tenant_id, fingerprint) DO UPDATE SET status = 'released', triaged_at = now(), triage_reason = EXCLUDED.triage_reason,
                  evidence = EXCLUDED.evidence, replay = EXCLUDED.replay, oracle = EXCLUDED.oracle WHERE demo.findings.status = 'suspected'`
             : 'ON CONFLICT (tenant_id, fingerprint) DO NOTHING'
         }
         RETURNING id`,
        [
          row.id, run.tenantId, run.id, run.assetId, row.fingerprint, row.title, row.testCaseId, row.vulnClass, row.cwe, row.owasp,
          JSON.stringify({ level: row.severity }), JSON.stringify(row.location), row.status, JSON.stringify(row.oracle),
          JSON.stringify(row.evidence), JSON.stringify(row.replay), row.reproCurl, row.agent, row.description, AUTO_RELEASE_REASON,
        ],
      );
      return r.rows[0]?.id ?? null;
    },
    async recordDelivery(findingId: string, status: 'delivered' | 'failed', detail: string): Promise<void> {
      await pool.query('UPDATE demo.findings SET delivery_status = $2, delivery_detail = $3, delivered_at = now() WHERE id = $1', [findingId, status, detail]);
    },
    async saveProgress(runId: string, requestsUsed: number, costUsd: number): Promise<void> {
      await pool.query('UPDATE demo.runs SET requests_used = $2, cost_usd = $3 WHERE id = $1', [runId, requestsUsed, costUsd]);
    },
    async finishRun(run: HuntRun, outcome: RunOutcome): Promise<void> {
      await pool.query('UPDATE demo.runs SET state = $2, requests_used = $3, cost_usd = $4, summary = $5, finished_at = now() WHERE id = $1', [
        run.id, outcome.state, outcome.requestsUsed, outcome.costUsd, outcome.summary,
      ]);
      await pool.query('UPDATE demo.assessment_requests SET status = $3 WHERE tenant_id = $1 AND id = $2', [run.tenantId, run.requestId, outcome.state === 'completed' ? 'completed' : 'approved']);
    },
    async markKilled(run: HuntRun): Promise<number> {
      const r = await pool.query<{ halt_ms: number }>(
        `UPDATE demo.runs SET state = 'killed', killed_at = now(), finished_at = now(),
           halt_ms = (extract(epoch FROM now() - kill_requested_at) * 1000)::int
         WHERE id = $1 RETURNING halt_ms`,
        [run.id],
      );
      await pool.query("UPDATE demo.assessment_requests SET status = 'approved' WHERE tenant_id = $1 AND id = $2", [run.tenantId, run.requestId]);
      return r.rows[0]?.halt_ms ?? 0;
    },
  };
}
