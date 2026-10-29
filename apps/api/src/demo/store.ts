// DEMO-STORY persistence: every query against the `demo` schema (migration 20261029200000_demo_story_schema).
// Every query filters on tenant_id. The schema has no RLS (demo only, see the migration header).
import type pg from 'pg';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface AssetRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly slug: string;
  readonly name: string;
  readonly base_url: string;
  readonly ownership_status: string;
  readonly verification_method: string | null;
}

export interface RequestRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly asset_id: string;
  readonly requester_id: string;
  readonly approver_id: string | null;
  readonly test_case_id: string;
  readonly scope: Record<string, unknown>;
  readonly intrusiveness: string;
  readonly budget_requests: number;
  readonly budget_seconds: number;
  readonly status: string;
  readonly decision_reason: string | null;
  readonly decided_at: Date | null;
  readonly created_at: Date;
  readonly requester_name: string | null;
  readonly approver_name: string | null;
}

export interface RunRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly request_id: string;
  readonly created_by: string;
  readonly state: string;
  readonly pins: Record<string, unknown>;
  readonly requests_used: number;
  readonly budget_requests: number;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
}

export interface RunEventRow {
  readonly seq: number;
  readonly kind: string;
  readonly stage: string;
  readonly message: string;
  readonly data: Record<string, unknown>;
  readonly at: Date;
}

export interface FindingRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly asset_id: string;
  readonly fingerprint: string;
  readonly title: string;
  readonly test_case_id: string;
  readonly class: string;
  readonly cwe_id: string;
  readonly owasp_category: string;
  readonly severity: Record<string, unknown>;
  readonly location: Record<string, unknown>;
  readonly status: string;
  readonly confidence: string;
  readonly oracle: Record<string, unknown>;
  readonly evidence: Record<string, unknown>;
  readonly replay: Record<string, unknown>;
  readonly repro_curl: string;
  readonly created_at: Date;
}

const REQUEST_SELECT = `
  SELECT r.id, r.tenant_id, r.asset_id, r.requester_id, r.approver_id, r.test_case_id, r.scope,
         r.intrusiveness, r.budget_requests, r.budget_seconds, r.status, r.decision_reason,
         r.decided_at, r.created_at, req.name AS requester_name, appr.name AS approver_name
  FROM demo.assessment_requests r
  JOIN users req ON req.id = r.requester_id
  LEFT JOIN users appr ON appr.id = r.approver_id`;

export class DemoStore {
  constructor(private readonly pool: pg.Pool) {}

  async close(): Promise<void> {
    await this.pool.end();
  }

  async findActiveUserByEmail(email: string): Promise<UserRow | null> {
    const r = await this.pool.query<UserRow>(
      "SELECT id, email, name FROM users WHERE lower(email) = lower($1) AND status = 'active'",
      [email],
    );
    return r.rows[0] ?? null;
  }

  async listAssets(tenantId: string): Promise<AssetRow[]> {
    const r = await this.pool.query<AssetRow>(
      'SELECT * FROM demo.assets WHERE tenant_id = $1 ORDER BY created_at, slug',
      [tenantId],
    );
    return r.rows;
  }

  async getAsset(tenantId: string, id: string): Promise<AssetRow | null> {
    const r = await this.pool.query<AssetRow>(
      'SELECT * FROM demo.assets WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }

  async upsertAsset(row: AssetRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO demo.assets (id, tenant_id, slug, name, base_url, ownership_status, verification_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET base_url = EXCLUDED.base_url, name = EXCLUDED.name,
         ownership_status = EXCLUDED.ownership_status, verification_method = EXCLUDED.verification_method`,
      [
        row.id,
        row.tenant_id,
        row.slug,
        row.name,
        row.base_url,
        row.ownership_status,
        row.verification_method,
      ],
    );
  }

  async insertRequest(row: {
    id: string;
    tenant_id: string;
    asset_id: string;
    requester_id: string;
    test_case_id: string;
    scope: Record<string, unknown>;
    intrusiveness: string;
    budget_requests: number;
    budget_seconds: number;
    status: string;
    approver_id?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO demo.assessment_requests (id, tenant_id, asset_id, requester_id, test_case_id, scope,
         intrusiveness, budget_requests, budget_seconds, status, approver_id, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $11::uuid IS NULL THEN NULL ELSE now() END)`,
      [
        row.id,
        row.tenant_id,
        row.asset_id,
        row.requester_id,
        row.test_case_id,
        JSON.stringify(row.scope),
        row.intrusiveness,
        row.budget_requests,
        row.budget_seconds,
        row.status,
        row.approver_id ?? null,
      ],
    );
  }

  async listRequests(tenantId: string, limit: number): Promise<RequestRow[]> {
    const r = await this.pool.query<RequestRow>(
      `${REQUEST_SELECT} WHERE r.tenant_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return r.rows;
  }

  async getRequest(tenantId: string, id: string): Promise<RequestRow | null> {
    const r = await this.pool.query<RequestRow>(
      `${REQUEST_SELECT} WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }

  /** Conditional update: only a request still pending Gate 1 can be decided (no lost update). */
  async decideRequest(
    tenantId: string,
    id: string,
    approverId: string,
    status: 'approved' | 'rejected',
    reason: string | null,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE demo.assessment_requests
       SET status = $4, approver_id = $3, decision_reason = $5, decided_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending_gate1' AND requester_id <> $3`,
      [tenantId, id, approverId, status, reason],
    );
    return (r.rowCount ?? 0) === 1;
  }

  /** Moves an approved request to running, once. Returns false when another start won the race. */
  async claimRequestForRun(tenantId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE demo.assessment_requests SET status = 'running'
       WHERE tenant_id = $1 AND id = $2 AND status = 'approved'`,
      [tenantId, id],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async insertRun(row: {
    id: string;
    tenant_id: string;
    request_id: string;
    created_by: string;
    pins: Record<string, unknown>;
    budget_requests: number;
    /** Only the seeded fallback run sets these; live runs start `queued` with nothing used. */
    state?: string;
    requests_used?: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO demo.runs (id, tenant_id, request_id, created_by, state, pins, budget_requests,
         requests_used, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
         CASE WHEN $5 = 'completed' THEN now() ELSE NULL END,
         CASE WHEN $5 = 'completed' THEN now() ELSE NULL END)`,
      [
        row.id,
        row.tenant_id,
        row.request_id,
        row.created_by,
        row.state ?? 'queued',
        JSON.stringify(row.pins),
        row.budget_requests,
        row.requests_used ?? 0,
      ],
    );
  }

  async appendEvent(
    runId: string,
    seq: number,
    event: { kind: string; stage: string; message: string; data?: Record<string, unknown> },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO demo.run_events (run_id, seq, kind, stage, message, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, seq, event.kind, event.stage, event.message, JSON.stringify(event.data ?? {})],
    );
  }

  async getRun(tenantId: string, id: string): Promise<RunRow | null> {
    const r = await this.pool.query<RunRow>(
      'SELECT * FROM demo.runs WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }

  async findRunByRequest(tenantId: string, requestId: string): Promise<RunRow | null> {
    const r = await this.pool.query<RunRow>(
      'SELECT * FROM demo.runs WHERE tenant_id = $1 AND request_id = $2 ORDER BY created_at DESC LIMIT 1',
      [tenantId, requestId],
    );
    return r.rows[0] ?? null;
  }

  async listRuns(tenantId: string, limit: number): Promise<RunRow[]> {
    const r = await this.pool.query<RunRow>(
      'SELECT * FROM demo.runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
      [tenantId, limit],
    );
    return r.rows;
  }

  async listEvents(runId: string, afterSeq: number): Promise<RunEventRow[]> {
    const r = await this.pool.query<RunEventRow>(
      `SELECT seq, kind, stage, message, data, at FROM demo.run_events
       WHERE run_id = $1 AND seq > $2 ORDER BY seq`,
      [runId, afterSeq],
    );
    return r.rows;
  }

  async findingForRun(tenantId: string, runId: string): Promise<FindingRow | null> {
    const r = await this.pool.query<FindingRow>(
      'SELECT * FROM demo.findings WHERE tenant_id = $1 AND run_id = $2 LIMIT 1',
      [tenantId, runId],
    );
    return r.rows[0] ?? null;
  }

  async getFinding(tenantId: string, id: string): Promise<FindingRow | null> {
    const r = await this.pool.query<FindingRow>(
      'SELECT * FROM demo.findings WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }

  async listFindings(tenantId: string, limit: number): Promise<FindingRow[]> {
    const r = await this.pool.query<FindingRow>(
      'SELECT * FROM demo.findings WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
      [tenantId, limit],
    );
    return r.rows;
  }

  async insertFinding(row: {
    id: string;
    tenant_id: string;
    run_id: string;
    asset_id: string;
    fingerprint: string;
    title: string;
    test_case_id: string;
    class: string;
    cwe_id: string;
    owasp_category: string;
    severity: Record<string, unknown>;
    location: Record<string, unknown>;
    confidence: number;
    oracle: Record<string, unknown>;
    evidence: Record<string, unknown>;
    replay: Record<string, unknown>;
    repro_curl: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO demo.findings (id, tenant_id, run_id, asset_id, fingerprint, title, test_case_id, class,
         cwe_id, owasp_category, severity, location, status, confidence, oracle, evidence, replay, repro_curl)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'confirmed', $13, $14, $15, $16, $17)
       ON CONFLICT (tenant_id, fingerprint) DO NOTHING`,
      [
        row.id,
        row.tenant_id,
        row.run_id,
        row.asset_id,
        row.fingerprint,
        row.title,
        row.test_case_id,
        row.class,
        row.cwe_id,
        row.owasp_category,
        JSON.stringify(row.severity),
        JSON.stringify(row.location),
        row.confidence,
        JSON.stringify(row.oracle),
        JSON.stringify(row.evidence),
        JSON.stringify(row.replay),
        row.repro_curl,
      ],
    );
  }

  async setRunState(
    runId: string,
    state: string,
    requestsUsed: number,
    finished: boolean,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE demo.runs SET state = $2, requests_used = $3,
         started_at = COALESCE(started_at, now()),
         finished_at = CASE WHEN $4 THEN now() ELSE finished_at END
       WHERE id = $1`,
      [runId, state, requestsUsed, finished],
    );
  }

  async setRequestStatus(tenantId: string, id: string, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE demo.assessment_requests SET status = $3 WHERE tenant_id = $1 AND id = $2',
      [tenantId, id, status],
    );
  }

  async countFinishedRunsForAsset(tenantId: string, assetId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM demo.runs ru
       JOIN demo.assessment_requests rq ON rq.id = ru.request_id
       WHERE ru.tenant_id = $1 AND rq.asset_id = $2 AND ru.state = 'completed'`,
      [tenantId, assetId],
    );
    return Number(r.rows[0]?.n ?? '0');
  }
}
