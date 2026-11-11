// Hunt persistence over `pg` (demo schema, see migration 20261105000000_demo_ai_hunt).
import { z } from 'zod';

import { DEMO_GENESIS, demoAuditHash, type DemoAuditPayload } from '@blackwing/audit';
import { newId } from '@blackwing/ids';

import { REPLAYS } from './hunt/validator.js';

import type { ExchangeRow, FindingRow, Gate2CloseReason, Gate2Row, Gate2Status, HuntRun, HuntStore, RetestJob, RetestResult, RunControl, RunEvent, RunOutcome, StaleRun } from './hunt/types.js';
import type pg from 'pg';

const pinsSchema = z.object({
  asset: z.object({
    id: z.string(),
    name: z.string(),
    allowedOrigins: z.array(z.string()),
    excludedPaths: z.array(z.string()),
    // Runs pinned before the lab allow-list existed: no origin is a lab, so private addresses stay refused.
    labOrigins: z.array(z.string()).default([]),
  }),
  request: z.object({
    id: z.string(),
    objective: z.string(),
    budget: z.object({ requests: z.number(), seconds: z.number(), costUsd: z.number() }),
    intrusiveness: z.enum(['passive', 'active_safe']).default('active_safe'),
    // Runs pinned before release modes existed keep their behaviour: automatic release.
    releaseProven: z.enum(['hold', 'auto']).default('auto'),
  }),
});

const testAccountsSchema = z.array(z.object({ role: z.string(), header_name: z.string(), header_value: z.string(), username: z.string().optional(), password: z.string().optional(), login_url: z.string().optional() })).default([]);

interface ClaimedRow {
  id: string;
  tenant_id: string;
  request_id: string;
  pins: unknown;
  test_accounts: unknown;
}

const UNIQUE_VIOLATION = '23505';
const RETEST_SECONDS = 60;
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

/** Claims the oldest queued retest with its finding's evidence and run pins (same tenant only). */
const CLAIM_RETEST_SQL = `
  WITH claimed AS (
    UPDATE demo.finding_retests SET status = 'running', started_at = now()
    WHERE id = (SELECT id FROM demo.finding_retests WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, finding_id, tenant_id
  )
  SELECT c.id AS retest_id, c.finding_id, f.evidence, f.oracle, r.id, r.tenant_id, r.request_id, r.pins, q.test_accounts
  FROM claimed c
  JOIN demo.findings f ON f.id = c.finding_id AND f.tenant_id = c.tenant_id
  JOIN demo.runs r ON r.id = f.run_id AND r.tenant_id = c.tenant_id
  JOIN demo.assessment_requests q ON q.id = r.request_id AND q.tenant_id = c.tenant_id`;

/** A claimed row as the hunt's run: pins (what Gate 1 approved) plus the request row's test accounts. */
function toHuntRun(row: ClaimedRow): HuntRun {
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
    testAccounts: testAccountsSchema.parse(row.test_accounts).map((a) => ({
      role: a.role,
      headerName: a.header_name,
      headerValue: a.header_value,
      ...(a.username === undefined ? {} : { login: { username: a.username, password: a.password ?? '', loginUrl: a.login_url ?? null } }),
    })),
    releaseProven: pins.request.releaseProven,
    labOrigins: pins.asset.labOrigins,
  };
}

const LEDGER_ACTOR = 'Blackwing';

/**
 * Appends one worker entry to the tenant's demo ledger inside the caller's transaction, under the same advisory lock
 * the API takes (packages/audit demo-chain rules), so the two writers never fork the chain.
 */
async function appendLedger(
  client: pg.PoolClient,
  tenantId: string,
  action: string,
  targetType: string,
  targetId: string,
  payload: DemoAuditPayload,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('demo.audit_events:' || $1::text))", [tenantId]);
  const last = await client.query<{ seq: number; hash: string }>(
    'SELECT seq, hash FROM demo.audit_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1',
    [tenantId],
  );
  const prevHash = last.rows[0]?.hash ?? DEMO_GENESIS;
  const fields = { seq: (last.rows[0]?.seq ?? 0) + 1, at: new Date(), actorId: null, actorName: LEDGER_ACTOR, action, targetType, targetId, payload };
  await client.query(
    `INSERT INTO demo.audit_events (id, tenant_id, seq, actor_id, actor_name, action, target_type, target_id, payload, prev_hash, hash, at)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [newId(), tenantId, fields.seq, LEDGER_ACTOR, action, targetType, targetId, JSON.stringify(payload), prevHash, demoAuditHash(prevHash, fields), fields.at],
  );
}

/** Why an older copy of an issue left the Gate 3 queue: the same issue was proven again, newer evidence waits instead. */
const SUPERSEDED_REASON = 'Superseded: the same issue was proven again in a newer audit';

export function pgHuntStore(pool: pg.Pool): HuntStore {
  const gate2Status = async (id: string): Promise<{ status: Gate2Status; decidedBy: string | null }> => {
    const r = await pool.query<{ status: Gate2Status; decided_by: string | null }>('SELECT status, decided_by FROM demo.gate2_requests WHERE id = $1', [id]);
    const row = r.rows[0];
    return { status: row?.status ?? 'denied', decidedBy: row?.decided_by ?? null };
  };
  /** The close and its `gate2.expired` ledger entry commit together: an expiry is never unrecorded. */
  const closeGate2 = async (id: string, status: 'denied' | 'expired', reason: Gate2CloseReason): Promise<Gate2Status> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const moved = await client.query<{ tenant_id: string; run_id: string; method: string; url: string; deadline_at: Date }>(
        `UPDATE demo.gate2_requests SET status = $2, decided_at = now(), close_reason = $3 WHERE id = $1 AND status = 'pending'
         RETURNING tenant_id, run_id, method, url, deadline_at`,
        [id, status, reason],
      );
      const row = moved.rows[0];
      if (row !== undefined && status === 'expired') {
        await appendLedger(client, row.tenant_id, 'gate2.expired', 'gate2', id, {
          runId: row.run_id,
          method: row.method,
          // Origin and path only: the immutable ledger never keeps a query value the agent typed (a password).
          url: row.url.split(/[?#]/, 1)[0] ?? '',
          reason,
          deadlineAt: row.deadline_at.toISOString(),
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return (await gate2Status(id)).status;
  };

  return {
    async claimQueuedRun(): Promise<HuntRun | null> {
      const r = await pool.query<ClaimedRow>(CLAIM_SQL);
      const row = r.rows[0];
      return row === undefined ? null : toHuntRun(row);
    },
    async claimQueuedRetest(): Promise<RetestJob | null> {
      const r = await pool.query<ClaimedRow & { retest_id: string; finding_id: string; evidence: Record<string, unknown> | null; oracle: unknown }>(CLAIM_RETEST_SQL);
      const row = r.rows[0];
      if (row === undefined) return null;
      const side = (key: string): unknown => (row.evidence?.[key] as { request?: unknown } | undefined)?.request;
      // Only the probe replays and the control may be sent: one request each, nothing more.
      const run = { ...toHuntRun(row), budgetRequests: REPLAYS + 1, budgetSeconds: RETEST_SECONDS };
      return { id: row.retest_id, findingId: row.finding_id, run, probe: side('probe'), control: side('control'), oracle: row.oracle };
    },
    async finishRetest(id: string, result: RetestResult): Promise<void> {
      await pool.query(
        "UPDATE demo.finding_retests SET status = $2, result = $3, detail = $4, finished_at = now() WHERE id = $1 AND status = 'running'",
        [id, result.status, result.result, JSON.stringify(result.detail)],
      );
    },
    async failStaleRuns(): Promise<StaleRun[]> {
      const r = await pool.query<{ id: string; request_id: string; requests_used: number; cost_usd: string; findings: number }>(
        `UPDATE demo.runs r SET state = 'failed', finished_at = now() WHERE state IN ('running', 'paused')
         RETURNING id, request_id, requests_used, cost_usd,
           (SELECT count(*)::int FROM demo.findings f WHERE f.run_id = r.id AND f.status IN ('confirmed', 'released')) AS findings`,
      );
      const ids = r.rows.map((row) => row.id);
      await pool.query(
        `UPDATE demo.finding_retests SET status = 'failed', finished_at = now(),
           detail = jsonb_build_object('reason', 'The worker restarted during the retest.') WHERE status = 'running'`,
      );
      const asks = await pool.query<{ id: string }>("SELECT id FROM demo.gate2_requests WHERE run_id = ANY($1) AND status = 'pending'", [ids]);
      for (const ask of asks.rows) await closeGate2(ask.id, 'expired', 'worker_restarted');
      // Terminal: the approval was used by this run; another run needs a new Gate 1 decision.
      await pool.query("UPDATE demo.assessment_requests SET status = 'failed' WHERE id = ANY($1)", [r.rows.map((row) => row.request_id)]);
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
        `INSERT INTO demo.gate2_requests (id, tenant_id, run_id, agent, method, url, path_key, intrusiveness, reason, why_outside, deadline_at,
           request_body, as_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'state_changing', $8, $9, $10, $11, $12)`,
        [row.id, run.tenantId, run.id, row.agent, row.method, row.url, row.pathKey, row.reason, row.whyOutside, row.deadlineAt, row.body, row.asRole],
      );
    },
    readGate2: gate2Status,
    closeGate2,
    /** Asks the run closes itself (run end, kill): `expired`, not `denied` (no person said no), each on the ledger. */
    async closePendingGate2(runId: string, reason: 'run_ended' | 'killed'): Promise<string[]> {
      const r = await pool.query<{ id: string }>("SELECT id FROM demo.gate2_requests WHERE run_id = $1 AND status = 'pending'", [runId]);
      const closed: string[] = [];
      for (const { id } of r.rows) if ((await closeGate2(id, 'expired', reason)) === 'expired') closed.push(id);
      return closed;
    },
    async insertFinding(run: HuntRun, row: FindingRow): Promise<string | null> {
      const proven = row.status !== 'suspected';
      const r = await pool.query<{ id: string }>(
        `INSERT INTO demo.findings (id, tenant_id, run_id, asset_id, fingerprint, title, test_case_id, class, cwe_id, owasp_category,
           severity, location, status, confidence, oracle, evidence, replay, repro_curl, agent, description, triaged_at, triage_reason,
           identity_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $15, $16, $17, $18, $19,
           CASE WHEN $13::text = 'released' THEN now() END, CASE WHEN $13::text = 'released' THEN $20::text END, $21)
         ${
           proven
             ? `ON CONFLICT (tenant_id, fingerprint) DO UPDATE SET status = EXCLUDED.status, triaged_at = EXCLUDED.triaged_at, triage_reason = EXCLUDED.triage_reason,
                  evidence = EXCLUDED.evidence, replay = EXCLUDED.replay, oracle = EXCLUDED.oracle, location = EXCLUDED.location,
                  repro_curl = EXCLUDED.repro_curl WHERE demo.findings.status = 'suspected'`
             : // A copy of an issue already stored: no change, but its id comes back so the console shows the issue once.
               'ON CONFLICT (tenant_id, fingerprint) DO UPDATE SET fingerprint = demo.findings.fingerprint'
         }
         RETURNING id`,
        [
          row.id, run.tenantId, run.id, run.assetId, row.fingerprint, row.title, row.testCaseId, row.vulnClass, row.cwe, row.owasp,
          JSON.stringify({ level: row.severity }), JSON.stringify(row.location), row.status, JSON.stringify(row.oracle),
          JSON.stringify(row.evidence), JSON.stringify(row.replay), row.reproCurl, row.agent, row.description, AUTO_RELEASE_REASON,
          row.identityKey,
        ],
      );
      return r.rows[0]?.id ?? null;
    },
    async findingByFingerprint(run: HuntRun, fingerprint: string): Promise<{ id: string; title: string } | null> {
      const r = await pool.query<{ id: string; title: string }>('SELECT id, title FROM demo.findings WHERE tenant_id = $1 AND fingerprint = $2', [run.tenantId, fingerprint]);
      return r.rows[0] ?? null;
    },
    async supersedeCopies(run: HuntRun, findingId: string, identityKey: string): Promise<string[]> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query<{ id: string; run_id: string }>(
          `UPDATE demo.findings SET status = 'dismissed', triaged_at = now(), triage_reason = $5
           WHERE tenant_id = $1 AND asset_id = $2 AND identity_key = $3 AND id <> $4 AND status = 'confirmed' RETURNING id, run_id`,
          [run.tenantId, run.assetId, identityKey, findingId, SUPERSEDED_REASON],
        );
        for (const row of r.rows) {
          await appendLedger(client, run.tenantId, 'finding.superseded', 'finding', row.id, { runId: row.run_id, by: findingId, byRunId: run.id, reason: SUPERSEDED_REASON });
        }
        await client.query('COMMIT');
        return r.rows.map((row) => row.id);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
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
      // Terminal either way: an approval starts one run (a failed run needs a new Gate 1 decision).
      await pool.query('UPDATE demo.assessment_requests SET status = $3 WHERE tenant_id = $1 AND id = $2', [run.tenantId, run.requestId, outcome.state]);
    },
    async markKilled(run: HuntRun): Promise<number> {
      const r = await pool.query<{ halt_ms: number }>(
        `UPDATE demo.runs SET state = 'killed', killed_at = now(), finished_at = now(),
           halt_ms = (extract(epoch FROM now() - kill_requested_at) * 1000)::int
         WHERE id = $1 RETURNING halt_ms`,
        [run.id],
      );
      await pool.query("UPDATE demo.assessment_requests SET status = 'killed' WHERE tenant_id = $1 AND id = $2", [run.tenantId, run.requestId]);
      return r.rows[0]?.halt_ms ?? 0;
    },
  };
}
