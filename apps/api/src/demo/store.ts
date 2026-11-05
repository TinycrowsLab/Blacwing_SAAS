// DEMO-STORY persistence: every query against the `demo` schema (migrations 20261029200000_demo_story_schema, 20261105000000_demo_ai_hunt).
// Every query filters on tenant_id. The schema has no RLS (demo only, see the migration header).
import { newId } from '@blackwing/ids';

import { GENESIS, auditHash, type AuditFields, type AuditPayload, type AuditRef } from './audit.js';

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
  readonly allowed_origins: string[];
  readonly excluded_paths: string[];
  readonly verification_token: string | null;
  readonly verified_by: string | null;
  readonly verified_at: Date | null;
  readonly verified_by_name: string | null;
  readonly created_at: Date;
}

export interface RequestRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly asset_id: string;
  readonly requester_id: string;
  readonly approver_id: string | null;
  readonly objective: string;
  readonly scope: { readonly excludedPaths?: string[] };
  readonly intrusiveness: string;
  readonly budget_requests: number;
  readonly budget_seconds: number;
  readonly cost_cap_usd: string;
  readonly test_accounts: readonly {
    readonly role: string;
    readonly header_name: string;
    readonly header_value: string;
  }[];
  readonly status: string;
  readonly decision_reason: string | null;
  readonly decided_at: Date | null;
  readonly created_at: Date;
  readonly requester_name: string | null;
  readonly approver_name: string | null;
  readonly asset_name: string;
}

export interface RunRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly request_id: string;
  readonly state: string;
  readonly paused: boolean;
  readonly pins: Record<string, unknown>;
  readonly requests_used: number;
  readonly budget_requests: number;
  readonly budget_seconds: number;
  readonly cost_cap_usd: string;
  readonly cost_usd: string;
  readonly asset_name: string;
  readonly summary: string | null;
  readonly halt_ms: number | null;
  readonly kill_requested_at: Date | null;
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
  readonly title: string;
  readonly class: string;
  readonly cwe_id: string;
  readonly owasp_category: string;
  readonly severity: unknown;
  readonly status: string;
  readonly confidence: string;
  readonly agent: string | null;
  readonly description: string | null;
  readonly oracle: Record<string, unknown>;
  readonly evidence: Record<string, unknown>;
  readonly replay: Record<string, unknown>;
  readonly repro_curl: string;
  readonly location: { readonly method?: string; readonly url?: string };
  readonly test_case_id: string | null;
  readonly triaged_by: string | null;
  readonly triaged_at: Date | null;
  readonly triage_reason: string | null;
  readonly delivery_status: 'delivered' | 'failed' | null;
  readonly delivery_detail: string | null;
  readonly delivered_at: Date | null;
  readonly created_at: Date;
  readonly asset_name: string | null;
  readonly triaged_by_name: string | null;
}

export interface ExchangeRow {
  readonly id: string;
  readonly seq: number;
  readonly agent: string;
  readonly method: string;
  readonly url: string;
  readonly request_headers: Record<string, string>;
  readonly request_body: string | null;
  readonly status: number | null;
  readonly response_headers: Record<string, string> | null;
  readonly response_body: string | null;
  readonly duration_ms: number | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly at: Date;
}

export interface Gate2Row {
  readonly id: string;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly agent: string;
  readonly method: string;
  readonly url: string;
  readonly path_key: string;
  readonly intrusiveness: string;
  readonly reason: string | null;
  readonly why_outside: string | null;
  readonly status: string;
  readonly deadline_at: Date;
  readonly decided_by: string | null;
  readonly decision_reason: string | null;
  readonly decided_at: Date | null;
  readonly created_at: Date;
  readonly decided_by_name: string | null;
}

export interface AuditRow extends AuditFields {
  readonly eventId: string;
  readonly prevHash: string;
  readonly hash: string;
}

export interface DashboardCounts {
  readonly assets: number;
  readonly requestsPendingGate1: number;
  readonly runsRunning: number;
  readonly confirmedFindings: number;
}

export interface RunStats {
  readonly httpSent: number;
  readonly blocked: number;
  readonly gate2Pending: number;
}

const ASSET_SELECT = `
  SELECT a.*, u.name AS verified_by_name FROM demo.assets a LEFT JOIN users u ON u.id = a.verified_by`;

const REQUEST_SELECT = `
  SELECT r.*, req.name AS requester_name, appr.name AS approver_name, a.name AS asset_name
  FROM demo.assessment_requests r
  JOIN demo.assets a ON a.id = r.asset_id
  JOIN users req ON req.id = r.requester_id
  LEFT JOIN users appr ON appr.id = r.approver_id`;

const GATE2_SELECT = `
  SELECT g.*, u.name AS decided_by_name FROM demo.gate2_requests g LEFT JOIN users u ON u.id = g.decided_by`;

const FINDING_SELECT = `
  SELECT f.*, a.name AS asset_name, u.name AS triaged_by_name
  FROM demo.findings f
  JOIN demo.assets a ON a.id = f.asset_id
  LEFT JOIN users u ON u.id = f.triaged_by`;

const RUN_SELECT = `
  SELECT ru.*, rq.budget_seconds, rq.cost_cap_usd, a.name AS asset_name
  FROM demo.runs ru
  JOIN demo.assessment_requests rq ON rq.id = ru.request_id
  JOIN demo.assets a ON a.id = rq.asset_id`;

/** Bodies in exchange lists are excerpts; the full body stays in the table. */
const BODY_EXCERPT_CHARS = 2048;
const EXCHANGE_PAGE = 200;
const EVENT_APPEND_ATTEMPTS = 5;
const UNIQUE_VIOLATION = '23505';

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

  /**
   * First sign-in of an administrator: creates the user (keyed by the identity provider's subject) and its membership
   * in the tenant, in one transaction under the tenant's RLS context. Returns null when the e-mail is already taken
   * by another subject or the existing user is not active.
   */
  async provisionUser(
    tenantId: string,
    input: {
      readonly sub: string;
      readonly email: string;
      readonly name: string | null;
      readonly roles: readonly string[];
    },
  ): Promise<UserRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(
        'INSERT INTO users (keycloak_sub, email, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [input.sub, input.email, input.name],
      );
      const user = await client.query<UserRow & { status: string }>(
        'SELECT id, email, name, status FROM users WHERE keycloak_sub = $1',
        [input.sub],
      );
      const row = user.rows[0];
      if (row?.status !== 'active') {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, updated_at = now()`,
        [tenantId, row.id, [...input.roles]],
      );
      await client.query('COMMIT');
      return { id: row.id, email: row.email, name: row.name };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listAssets(tenantId: string): Promise<AssetRow[]> {
    const r = await this.pool.query<AssetRow>(
      `${ASSET_SELECT} WHERE a.tenant_id = $1 ORDER BY a.created_at DESC`,
      [tenantId],
    );
    return r.rows;
  }

  async getAsset(tenantId: string, id: string): Promise<AssetRow | null> {
    const r = await this.pool.query<AssetRow>(
      `${ASSET_SELECT} WHERE a.tenant_id = $1 AND a.id = $2`,
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }

  async insertAsset(row: {
    id: string;
    tenant_id: string;
    slug: string;
    name: string;
    base_url: string;
    allowed_origins: string[];
    excluded_paths: string[];
    verification_token: string;
    created_by: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO demo.assets (id, tenant_id, slug, name, base_url, allowed_origins, excluded_paths,
         verification_token, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id,
        row.tenant_id,
        row.slug,
        row.name,
        row.base_url,
        row.allowed_origins,
        row.excluded_paths,
        row.verification_token,
        row.created_by,
      ],
    );
  }

  /** Conditional update: only an unverified asset can be verified (once). */
  async markAssetVerified(
    tenantId: string,
    id: string,
    method: 'http_token' | 'owner_attestation',
    verifiedBy: string,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE demo.assets SET ownership_status = 'verified', verification_method = $3,
         verified_by = $4, verified_at = now()
       WHERE tenant_id = $1 AND id = $2 AND ownership_status = 'unverified'`,
      [tenantId, id, method, verifiedBy],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async insertRequest(row: {
    id: string;
    tenant_id: string;
    asset_id: string;
    requester_id: string;
    objective: string;
    scope: Record<string, unknown>;
    intrusiveness: string;
    budget_requests: number;
    budget_seconds: number;
    cost_cap_usd: number;
    test_accounts: { role: string; header_name: string; header_value: string }[];
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO demo.assessment_requests (id, tenant_id, asset_id, requester_id, objective, scope,
         intrusiveness, budget_requests, budget_seconds, cost_cap_usd, test_accounts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        row.id,
        row.tenant_id,
        row.asset_id,
        row.requester_id,
        row.objective,
        JSON.stringify(row.scope),
        row.intrusiveness,
        row.budget_requests,
        row.budget_seconds,
        row.cost_cap_usd,
        JSON.stringify(row.test_accounts),
      ],
    );
  }

  async listPendingGate1(tenantId: string): Promise<RequestRow[]> {
    const r = await this.pool.query<RequestRow>(
      `${REQUEST_SELECT} WHERE r.tenant_id = $1 AND r.status = 'pending_gate1' ORDER BY r.created_at DESC`,
      [tenantId],
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

  /** Conditional update: only a request still pending Gate 1 can be decided (no lost update). Separation of duties is the service's rule. */
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
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending_gate1'`,
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
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO demo.runs (id, tenant_id, request_id, created_by, pins, budget_requests)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.id,
        row.tenant_id,
        row.request_id,
        row.created_by,
        JSON.stringify(row.pins),
        row.budget_requests,
      ],
    );
  }

  /**
   * Appends the next event of a run. The API and the worker both append, so the seq is allocated in the
   * statement and a lost race (unique violation) retries.
   */
  async appendEvent(
    runId: string,
    event: { kind: string; stage: string; message: string; data?: Record<string, unknown> },
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.pool.query(
          `INSERT INTO demo.run_events (run_id, seq, kind, stage, message, data)
           SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM demo.run_events WHERE run_id = $1`,
          [runId, event.kind, event.stage, event.message, JSON.stringify(event.data ?? {})],
        );
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== UNIQUE_VIOLATION || attempt >= EVENT_APPEND_ATTEMPTS) throw error;
      }
    }
  }

  async getRun(tenantId: string, id: string): Promise<RunRow | null> {
    const r = await this.pool.query<RunRow>(
      `${RUN_SELECT} WHERE ru.tenant_id = $1 AND ru.id = $2`,
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }

  async findRunByRequest(tenantId: string, requestId: string): Promise<RunRow | null> {
    const r = await this.pool.query<RunRow>(
      `${RUN_SELECT} WHERE ru.tenant_id = $1 AND ru.request_id = $2 ORDER BY ru.created_at DESC LIMIT 1`,
      [tenantId, requestId],
    );
    return r.rows[0] ?? null;
  }

  async listRuns(tenantId: string, limit: number): Promise<RunRow[]> {
    const r = await this.pool.query<RunRow>(
      `${RUN_SELECT} WHERE ru.tenant_id = $1 ORDER BY ru.created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return r.rows;
  }

  /** Pause or resume a run that has not finished. False when the run is finished or already in that state. */
  async setPaused(tenantId: string, id: string, paused: boolean): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE demo.runs SET paused = $3
       WHERE tenant_id = $1 AND id = $2 AND state IN ('queued', 'running', 'paused') AND paused <> $3`,
      [tenantId, id, paused],
    );
    return (r.rowCount ?? 0) === 1;
  }

  /** A queued run has no worker to halt it: it is killed right here. Null when it is no longer queued. */
  async killQueuedRun(tenantId: string, id: string, by: string): Promise<Date | null> {
    const r = await this.pool.query<{ killed_at: Date }>(
      `UPDATE demo.runs SET state = 'killed', kill_requested_at = now(), kill_requested_by = $3,
         killed_at = now(), halt_ms = 0, finished_at = now()
       WHERE tenant_id = $1 AND id = $2 AND state = 'queued' RETURNING killed_at`,
      [tenantId, id, by],
    );
    return r.rows[0]?.killed_at ?? null;
  }

  /** Flags a running run for the worker, which polls the flag. Keeps the first request time. */
  async requestKill(tenantId: string, id: string, by: string): Promise<Date | null> {
    const r = await this.pool.query<{ kill_requested_at: Date }>(
      `UPDATE demo.runs SET kill_requested_at = coalesce(kill_requested_at, now()),
         kill_requested_by = coalesce(kill_requested_by, $3)
       WHERE tenant_id = $1 AND id = $2 AND state IN ('running', 'paused') RETURNING kill_requested_at`,
      [tenantId, id, by],
    );
    return r.rows[0]?.kill_requested_at ?? null;
  }

  async listEvents(runId: string, afterSeq: number): Promise<RunEventRow[]> {
    const r = await this.pool.query<RunEventRow>(
      `SELECT seq, kind, stage, message, data, at FROM demo.run_events
       WHERE run_id = $1 AND seq > $2 ORDER BY seq`,
      [runId, afterSeq],
    );
    return r.rows;
  }

  async runStats(runId: string): Promise<RunStats> {
    const r = await this.pool.query<{ http_sent: string; blocked: string; gate2_pending: string }>(
      `SELECT (SELECT count(*) FROM demo.run_events WHERE run_id = $1 AND kind = 'http.sent')::text AS http_sent,
              (SELECT count(*) FROM demo.run_events WHERE run_id = $1 AND kind = 'policy.blocked')::text AS blocked,
              (SELECT count(*) FROM demo.gate2_requests
                 WHERE run_id = $1 AND status = 'pending' AND deadline_at > now())::text AS gate2_pending`,
      [runId],
    );
    const row = r.rows[0];
    return {
      httpSent: Number(row?.http_sent ?? 0),
      blocked: Number(row?.blocked ?? 0),
      gate2Pending: Number(row?.gate2_pending ?? 0),
    };
  }

  async listExchanges(runId: string, afterSeq: number): Promise<ExchangeRow[]> {
    const r = await this.pool.query<ExchangeRow>(
      `SELECT id, seq, agent, method, url, request_headers, left(request_body, $3) AS request_body, status,
              response_headers, left(response_body, $3) AS response_body, duration_ms, outcome, reason, at
       FROM demo.http_exchanges WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $4`,
      [runId, afterSeq, BODY_EXCERPT_CHARS, EXCHANGE_PAGE],
    );
    return r.rows;
  }

  async listGate2ForRun(tenantId: string, runId: string): Promise<Gate2Row[]> {
    const r = await this.pool.query<Gate2Row>(
      `${GATE2_SELECT} WHERE g.tenant_id = $1 AND g.run_id = $2 ORDER BY g.created_at`,
      [tenantId, runId],
    );
    return r.rows;
  }

  async listPendingGate2(tenantId: string): Promise<Gate2Row[]> {
    const r = await this.pool.query<Gate2Row>(
      `${GATE2_SELECT}
       WHERE g.tenant_id = $1 AND g.status = 'pending' AND g.deadline_at > now() ORDER BY g.deadline_at`,
      [tenantId],
    );
    return r.rows;
  }

  async getGate2(tenantId: string, id: string): Promise<Gate2Row | null> {
    const r = await this.pool.query<Gate2Row>(
      `${GATE2_SELECT} WHERE g.tenant_id = $1 AND g.id = $2`,
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }

  /** Decides a pending Gate 2 request before its deadline. False when it is closed (decided or expired). */
  async decideGate2(
    tenantId: string,
    id: string,
    status: 'approved' | 'denied',
    decidedBy: string,
    reason: string | null,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE demo.gate2_requests SET status = $3, decided_by = $4, decision_reason = $5, decided_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending' AND deadline_at > now()`,
      [tenantId, id, status, decidedBy, reason],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async getFinding(tenantId: string, id: string): Promise<FindingRow | null> {
    const r = await this.pool.query<FindingRow>(
      `${FINDING_SELECT} WHERE f.tenant_id = $1 AND f.id = $2`,
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }

  /** Suspected findings are for analysts only: they are left out unless `includeSuspected`. */
  async listFindings(
    tenantId: string,
    limit: number,
    includeSuspected: boolean,
  ): Promise<FindingRow[]> {
    const r = await this.pool.query<FindingRow>(
      `${FINDING_SELECT} WHERE f.tenant_id = $1 AND ($3 OR f.status <> 'suspected')
       ORDER BY f.created_at DESC LIMIT $2`,
      [tenantId, limit, includeSuspected],
    );
    return r.rows;
  }

  async listFindingsForRun(
    tenantId: string,
    runId: string,
    includeSuspected: boolean,
  ): Promise<FindingRow[]> {
    const r = await this.pool.query<FindingRow>(
      `${FINDING_SELECT} WHERE f.tenant_id = $1 AND f.run_id = $2 AND ($3 OR f.status <> 'suspected')
       ORDER BY f.created_at`,
      [tenantId, runId, includeSuspected],
    );
    return r.rows;
  }

  /** Conditional update: the finding moves to `to` only from one of the `from` statuses. */
  async triageFinding(
    tenantId: string,
    id: string,
    from: readonly string[],
    to: 'released' | 'dismissed',
    by: string,
    reason: string,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE demo.findings SET status = $4, triaged_by = $5, triaged_at = now(), triage_reason = $6
       WHERE tenant_id = $1 AND id = $2 AND status = ANY($3)`,
      [tenantId, id, [...from], to, by, reason],
    );
    return (r.rowCount ?? 0) === 1;
  }

  /** Records the result of the last webhook POST (never the URL). */
  async recordDelivery(id: string, status: 'delivered' | 'failed', detail: string): Promise<void> {
    await this.pool.query(
      `UPDATE demo.findings SET delivery_status = $2, delivery_detail = $3, delivered_at = now() WHERE id = $1`,
      [id, status, detail],
    );
  }

  /** Appends to the tenant's hash chain: the last row is read under an advisory lock, then seq + 1 is written. */
  async appendAudit(
    tenantId: string,
    entry: {
      actorId: string;
      actorName: string;
      action: string;
      targetType: string;
      targetId: string;
      payload: AuditPayload;
    },
  ): Promise<AuditRef> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('demo.audit_events:' || $1::text))",
        [tenantId],
      );
      const last = await client.query<{ seq: number; hash: string }>(
        'SELECT seq, hash FROM demo.audit_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1',
        [tenantId],
      );
      const prevHash = last.rows[0]?.hash ?? GENESIS;
      const fields: AuditFields = { ...entry, seq: (last.rows[0]?.seq ?? 0) + 1, at: new Date() };
      const hash = auditHash(prevHash, fields);
      const eventId = newId();
      await client.query(
        `INSERT INTO demo.audit_events (id, tenant_id, seq, actor_id, actor_name, action, target_type, target_id,
           payload, prev_hash, hash, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          eventId,
          tenantId,
          fields.seq,
          fields.actorId,
          fields.actorName,
          fields.action,
          fields.targetType,
          fields.targetId,
          JSON.stringify(fields.payload),
          prevHash,
          hash,
          fields.at,
        ],
      );
      await client.query('COMMIT');
      return { eventId, hash };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async latestAudit(
    tenantId: string,
    targetType: string,
    targetId: string,
  ): Promise<AuditRef | null> {
    const r = await this.pool.query<{ id: string; hash: string }>(
      `SELECT id, hash FROM demo.audit_events
       WHERE tenant_id = $1 AND target_type = $2 AND target_id = $3 ORDER BY seq DESC LIMIT 1`,
      [tenantId, targetType, targetId],
    );
    const row = r.rows[0];
    return row === undefined ? null : { eventId: row.id, hash: row.hash };
  }

  /** The whole ledger in seq order (the chain is verified over all of it). */
  async listAudit(tenantId: string): Promise<AuditRow[]> {
    const r = await this.pool.query<{
      id: string;
      seq: number;
      actor_id: string | null;
      actor_name: string;
      action: string;
      target_type: string;
      target_id: string;
      payload: AuditPayload;
      prev_hash: string;
      hash: string;
      at: Date;
    }>('SELECT * FROM demo.audit_events WHERE tenant_id = $1 ORDER BY seq', [tenantId]);
    return r.rows.map((row) => ({
      eventId: row.id,
      seq: row.seq,
      at: row.at,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      payload: row.payload,
      prevHash: row.prev_hash,
      hash: row.hash,
    }));
  }

  async dashboardCounts(tenantId: string): Promise<DashboardCounts> {
    const r = await this.pool.query<Record<keyof DashboardCounts, string>>(
      `SELECT (SELECT count(*) FROM demo.assets WHERE tenant_id = $1)::text AS "assets",
              (SELECT count(*) FROM demo.assessment_requests
                 WHERE tenant_id = $1 AND status = 'pending_gate1')::text AS "requestsPendingGate1",
              (SELECT count(*) FROM demo.runs WHERE tenant_id = $1 AND state = 'running')::text AS "runsRunning",
              (SELECT count(*) FROM demo.findings
                 WHERE tenant_id = $1 AND status IN ('confirmed', 'released'))::text AS "confirmedFindings"`,
      [tenantId],
    );
    const row = r.rows[0];
    return {
      assets: Number(row?.assets ?? 0),
      requestsPendingGate1: Number(row?.requestsPendingGate1 ?? 0),
      runsRunning: Number(row?.runsRunning ?? 0),
      confirmedFindings: Number(row?.confirmedFindings ?? 0),
    };
  }
}
