// DEMO-STORY persistence: every query against the `demo` schema (migrations 20261029200000_demo_story_schema, 20261105000000_demo_ai_hunt).
// Every query filters on tenant_id. The schema has no RLS (demo only, see the migration header).
import { newId } from '@blackwing/ids';

import { GENESIS, auditHash, type AuditFields, type AuditPayload, type AuditRef } from './audit.js';

import type pg from 'pg';

/** An audit-order draft (demo.drafts): the wizard's answers, kept per person. */
export interface DraftRow {
  readonly id: string;
  readonly step: number;
  readonly answers: Record<string, unknown>;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface TenantRow {
  readonly id: string;
  readonly name: string;
}

/** An emergency stop link (demo.emergency_links). Only the SHA-256 of its token is stored. */
export interface EmergencyLinkRow {
  readonly id: string;
  readonly token_hash: Buffer;
  readonly label: string | null;
  readonly created_by: string;
  readonly created_by_name: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly last_used_at: Date | null;
}

/** The workspace's optional emergency contact (shown on the expired-link page). */
export interface EmergencyContact {
  readonly name: string;
  readonly phone: string;
}

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
  readonly scope: { readonly excludedPaths?: string[]; readonly releaseProven?: 'hold' | 'auto' };
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
  /** Plan version: every amend bumps it; Gate 1 decides one version. */
  readonly version: number;
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
  readonly created_by: string;
  readonly started_by_name: string | null;
  /** Only while queued: queued runs (every tenant) ahead of this one, and runs running or paused. */
  readonly queue_ahead: number | null;
  readonly queue_running: number | null;
  readonly state: string;
  readonly paused: boolean;
  readonly pins: Record<string, unknown>;
  readonly requests_used: number;
  readonly budget_requests: number;
  readonly budget_seconds: number;
  readonly cost_cap_usd: string;
  readonly cost_usd: string;
  readonly asset_id: string;
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
  readonly fingerprint: string;
  /** Cross-run identity (asset, method, normalised path, CWE); null on rows written before it existed. */
  readonly identity_key: string | null;
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
  /** The earliest finding with the same identity in an earlier run of the tenant (none: all null). */
  readonly seen_run_id: string | null;
  readonly seen_finding_id: string | null;
  readonly seen_status: string | null;
  readonly seen_at: Date | null;
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
  /** The request the agent asked to send (stored scrubbed); null on rows written before it existed. */
  readonly request_body: string | null;
  readonly as_role: string | null;
  readonly close_reason: string | null;
  readonly asset_name: string | null;
  readonly requester_id: string | null;
  readonly requester_name: string | null;
  readonly run_started_at: Date | null;
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

/** Exact counts of what waits for a human, uncapped (the console badge and "Your turn"). */
export interface PendingCounts {
  readonly gate1: number;
  readonly gate2: number;
  readonly gate3: number;
  readonly keptBack: number;
  readonly live: number;
}

export interface FindingRetestRow {
  readonly id: string;
  readonly status: string;
  readonly result: string | null;
  readonly requested_by: string;
  readonly requested_by_name: string | null;
  readonly detail: Record<string, unknown>;
  readonly created_at: Date;
  readonly finished_at: Date | null;
}

/** The plan fields an amend may change (request columns and the `scope` jsonb). */
export interface RequestAmend {
  readonly objective: string;
  readonly scope: Record<string, unknown>;
  readonly intrusiveness: string;
  readonly budget_requests: number;
  readonly budget_seconds: number;
  readonly cost_cap_usd: number;
  readonly test_accounts: readonly { role: string; header_name: string; header_value: string }[];
}

export interface AuditEntry {
  readonly actorId: string | null;
  readonly actorName: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly payload: AuditPayload;
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
  SELECT g.*, u.name AS decided_by_name, a.name AS asset_name, rq.requester_id, req.name AS requester_name,
    ru.started_at AS run_started_at
  FROM demo.gate2_requests g
  JOIN demo.runs ru ON ru.id = g.run_id
  JOIN demo.assessment_requests rq ON rq.id = ru.request_id
  JOIN demo.assets a ON a.id = rq.asset_id
  LEFT JOIN users req ON req.id = rq.requester_id
  LEFT JOIN users u ON u.id = g.decided_by`;

// `prev`: the earliest non-suspected finding with the same identity in a run created before this finding's run.
const FINDING_SELECT = `
  SELECT f.*, a.name AS asset_name, u.name AS triaged_by_name,
    prev.run_id AS seen_run_id, prev.id AS seen_finding_id, prev.status AS seen_status, prev.created_at AS seen_at
  FROM demo.findings f
  JOIN demo.assets a ON a.id = f.asset_id
  LEFT JOIN users u ON u.id = f.triaged_by
  LEFT JOIN LATERAL (
    SELECT p.run_id, p.id, p.status, p.created_at FROM demo.findings p
    JOIN demo.runs pr ON pr.id = p.run_id
    WHERE f.identity_key IS NOT NULL AND p.tenant_id = f.tenant_id AND p.identity_key = f.identity_key
      AND p.run_id <> f.run_id AND p.status <> 'suspected'
      AND pr.created_at < (SELECT r0.created_at FROM demo.runs r0 WHERE r0.id = f.run_id)
    ORDER BY p.created_at LIMIT 1
  ) prev ON true`;

// The queue columns are computed only for a queued run; the worker claims the oldest queued run of any tenant.
const RUN_SELECT = `
  SELECT ru.*, rq.asset_id, rq.budget_seconds, rq.cost_cap_usd, a.name AS asset_name, cb.name AS started_by_name,
    CASE WHEN ru.state = 'queued' THEN (SELECT count(*) FROM demo.runs q
      WHERE q.state = 'queued' AND (q.created_at, q.id) < (ru.created_at, ru.id))::int END AS queue_ahead,
    CASE WHEN ru.state = 'queued' THEN (SELECT count(*) FROM demo.runs q
      WHERE q.state IN ('running', 'paused'))::int END AS queue_running
  FROM demo.runs ru
  JOIN demo.assessment_requests rq ON rq.id = ru.request_id
  JOIN demo.assets a ON a.id = rq.asset_id
  LEFT JOIN users cb ON cb.id = ru.created_by`;

/** Run states the console treats as live (Stop, the live list, the badge). */
const LIVE_STATES = ['queued', 'running', 'paused'];

/** Bodies in exchange lists are excerpts; the full body stays in the table. */
export const BODY_EXCERPT_CHARS = 2048;
/** Read twice the excerpt, so a secret that straddles the cut is still whole when the service scrubs it. */
const BODY_READ_CHARS = BODY_EXCERPT_CHARS * 2;
const EXCHANGE_PAGE = 200;
const EVENT_APPEND_ATTEMPTS = 5;
const UNIQUE_VIOLATION = '23505';

export class DemoStore {
  constructor(private readonly pool: pg.Pool) {}

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Runs `fn` in one transaction under the tenant's RLS context (`tenants` and `memberships` force row security). */
  private async inTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getTenant(tenantId: string): Promise<TenantRow | null> {
    const r = await this.inTenant(tenantId, (c) =>
      c.query<TenantRow>('SELECT id, name FROM tenants WHERE id = $1', [tenantId]),
    );
    return r.rows[0] ?? null;
  }

  async renameTenant(tenantId: string, name: string): Promise<boolean> {
    const r = await this.inTenant(tenantId, (c) =>
      c.query('UPDATE tenants SET name = $2 WHERE id = $1', [tenantId, name]),
    );
    return (r.rowCount ?? 0) === 1;
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
      `${ASSET_SELECT} WHERE a.tenant_id = $1 AND a.archived_at IS NULL ORDER BY a.created_at DESC`,
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

  /** Archives an asset that has no live work: no queued, running or paused run and no request still open. */
  async archiveAsset(tenantId: string, id: string, by: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE demo.assets a SET archived_at = now(), archived_by = $3
       WHERE a.tenant_id = $1 AND a.id = $2 AND a.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM demo.assessment_requests q
                         WHERE q.asset_id = a.id AND q.status IN ('pending_gate1', 'approved', 'running'))
         AND NOT EXISTS (SELECT 1 FROM demo.runs u JOIN demo.assessment_requests q ON q.id = u.request_id
                         WHERE q.asset_id = a.id AND u.state IN ('queued', 'running', 'paused'))`,
      [tenantId, id, by],
    );
    return (r.rowCount ?? 0) === 1;
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

  /** Conditional update: a verified asset whose proof no longer holds goes back to unverified. */
  async markAssetUnverified(tenantId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE demo.assets SET ownership_status = 'unverified', verification_method = NULL, verified_by = NULL,
         verified_at = NULL
       WHERE tenant_id = $1 AND id = $2 AND ownership_status = 'verified'`,
      [tenantId, id],
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

  /**
   * Conditional update: only a request still pending Gate 1, at the plan version the approver saw (when given), can
   * be decided (no lost update). Separation of duties is the service's rule.
   */
  async decideRequest(
    tenantId: string,
    id: string,
    approverId: string,
    status: 'approved' | 'rejected',
    reason: string | null,
    version: number | null = null,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE demo.assessment_requests
       SET status = $4, approver_id = $3, decision_reason = $5, decided_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending_gate1' AND ($6::int IS NULL OR version = $6)`,
      [tenantId, id, approverId, status, reason, version],
    );
    return (r.rowCount ?? 0) === 1;
  }

  /** Amends a pending plan in place, only at the version the editor saw. Returns the new version, or null. */
  async amendRequest(tenantId: string, id: string, version: number, plan: RequestAmend): Promise<number | null> {
    const r = await this.pool.query<{ version: number }>(
      `UPDATE demo.assessment_requests
       SET objective = $4, scope = $5, intrusiveness = $6, budget_requests = $7, budget_seconds = $8,
         cost_cap_usd = $9, test_accounts = $10, version = version + 1
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending_gate1' AND version = $3
       RETURNING version`,
      [
        tenantId,
        id,
        version,
        plan.objective,
        JSON.stringify(plan.scope),
        plan.intrusiveness,
        plan.budget_requests,
        plan.budget_seconds,
        plan.cost_cap_usd,
        JSON.stringify(plan.test_accounts),
      ],
    );
    return r.rows[0]?.version ?? null;
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

  /** Every live run of the tenant, newest first (uncapped: Stop must reach each one). */
  async listLiveRuns(tenantId: string): Promise<RunRow[]> {
    const r = await this.pool.query<RunRow>(
      `${RUN_SELECT} WHERE ru.tenant_id = $1 AND ru.state = ANY($2) ORDER BY ru.created_at DESC`,
      [tenantId, LIVE_STATES],
    );
    return r.rows;
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

  /**
   * A queued run has no worker to halt it: it is killed right here, and its request closes as `killed` (the approval
   * is single-use). Null when it is no longer queued.
   */
  async killQueuedRun(tenantId: string, id: string, by: string | null): Promise<Date | null> {
    const r = await this.pool.query<{ killed_at: Date }>(
      `WITH killed AS (
         UPDATE demo.runs SET state = 'killed', kill_requested_at = now(), kill_requested_by = $3,
           killed_at = now(), halt_ms = 0, finished_at = now()
         WHERE tenant_id = $1 AND id = $2 AND state = 'queued' RETURNING request_id, killed_at
       ), closed AS (
         UPDATE demo.assessment_requests SET status = 'killed'
         WHERE tenant_id = $1 AND id IN (SELECT request_id FROM killed) AND status IN ('approved', 'running')
       )
       SELECT killed_at FROM killed`,
      [tenantId, id, by],
    );
    return r.rows[0]?.killed_at ?? null;
  }

  /** Flags a running run for the worker, which polls the flag. Keeps the first request time. */
  async requestKill(tenantId: string, id: string, by: string | null): Promise<Date | null> {
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

  /** The latest event of each of `kinds` in the run (one row per kind that occurred). */
  async lastEvents(runId: string, kinds: readonly string[]): Promise<RunEventRow[]> {
    const r = await this.pool.query<RunEventRow>(
      `SELECT DISTINCT ON (kind) seq, kind, stage, message, data, at FROM demo.run_events
       WHERE run_id = $1 AND kind = ANY($2) ORDER BY kind, seq DESC`,
      [runId, [...kinds]],
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
      [runId, afterSeq, BODY_READ_CHARS, EXCHANGE_PAGE],
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

  /** The newest findings that wait for a Gate 3 decision (status `confirmed`), whatever came after them. */
  async listAwaitingFindings(tenantId: string, limit: number): Promise<FindingRow[]> {
    const r = await this.pool.query<FindingRow>(
      `${FINDING_SELECT} WHERE f.tenant_id = $1 AND f.status = 'confirmed' ORDER BY f.created_at DESC LIMIT $2`,
      [tenantId, limit],
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

  async getFindings(tenantId: string, ids: readonly string[]): Promise<FindingRow[]> {
    const r = await this.pool.query<FindingRow>(
      `${FINDING_SELECT} WHERE f.tenant_id = $1 AND f.id = ANY($2::uuid[])`,
      [tenantId, [...ids]],
    );
    return r.rows;
  }

  /** Batch Gate 3: one conditional update for every id; returns the ids that moved. */
  async triageFindings(
    tenantId: string,
    ids: readonly string[],
    from: readonly string[],
    to: 'released' | 'dismissed',
    by: string,
    reason: string,
  ): Promise<string[]> {
    const r = await this.pool.query<{ id: string }>(
      `UPDATE demo.findings SET status = $4, triaged_by = $5, triaged_at = now(), triage_reason = $6
       WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = ANY($3) RETURNING id`,
      [tenantId, [...ids], [...from], to, by, reason],
    );
    return r.rows.map((row) => row.id);
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

  /** Queues a retest. False when one is already open for the finding (one queued or running at a time). */
  async insertRetest(row: { id: string; tenant_id: string; finding_id: string; requested_by: string }): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO demo.finding_retests (id, tenant_id, finding_id, requested_by) VALUES ($1, $2, $3, $4)`,
        [row.id, row.tenant_id, row.finding_id, row.requested_by],
      );
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return false;
      throw error;
    }
  }

  /** The latest retests of a finding, newest first. */
  async listRetests(tenantId: string, findingId: string, limit: number): Promise<FindingRetestRow[]> {
    const r = await this.pool.query<FindingRetestRow>(
      `SELECT t.id, t.status, t.result, t.requested_by, u.name AS requested_by_name, t.detail, t.created_at,
         t.finished_at
       FROM demo.finding_retests t LEFT JOIN users u ON u.id = t.requested_by
       WHERE t.tenant_id = $1 AND t.finding_id = $2 ORDER BY t.created_at DESC LIMIT $3`,
      [tenantId, findingId, limit],
    );
    return r.rows;
  }

  /** Records the result of the last webhook POST (never the URL). */
  async recordDelivery(id: string, status: 'delivered' | 'failed', detail: string): Promise<void> {
    await this.pool.query(
      `UPDATE demo.findings SET delivery_status = $2, delivery_detail = $3, delivered_at = now() WHERE id = $1`,
      [id, status, detail],
    );
  }

  /** Appends to the tenant's hash chain: the last row is read under an advisory lock, then seq + 1 is written. */
  async appendAudit(tenantId: string, entry: AuditEntry): Promise<AuditRef> {
    const [ref] = await this.appendAudits(tenantId, [entry]);
    if (ref === undefined) throw new Error('audit append returned nothing');
    return ref;
  }

  /** Appends several entries in order, in one transaction under the same lock as {@link appendAudit}. */
  async appendAudits(tenantId: string, entries: readonly AuditEntry[]): Promise<AuditRef[]> {
    if (entries.length === 0) return [];
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
      let prevHash = last.rows[0]?.hash ?? GENESIS;
      let seq = last.rows[0]?.seq ?? 0;
      const refs: AuditRef[] = [];
      for (const entry of entries) {
        seq += 1;
        const fields: AuditFields = { ...entry, seq, at: new Date() };
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
        refs.push({ eventId, hash });
        prevHash = hash;
      }
      await client.query('COMMIT');
      return refs;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The latest ledger event on a target, optionally of one action only. */
  async latestAudit(
    tenantId: string,
    targetType: string,
    targetId: string,
    action: string | null = null,
  ): Promise<AuditRef | null> {
    const r = await this.pool.query<{ id: string; hash: string }>(
      `SELECT id, hash FROM demo.audit_events
       WHERE tenant_id = $1 AND target_type = $2 AND target_id = $3 AND ($4::text IS NULL OR action = $4)
       ORDER BY seq DESC LIMIT 1`,
      [tenantId, targetType, targetId, action],
    );
    const row = r.rows[0];
    return row === undefined ? null : { eventId: row.id, hash: row.hash };
  }

  /** A person's order drafts, newest first. */
  async listDrafts(tenantId: string, ownerId: string): Promise<DraftRow[]> {
    const r = await this.pool.query<DraftRow>(
      `SELECT id, step, answers, created_at, updated_at FROM demo.drafts
       WHERE tenant_id = $1 AND owner_id = $2 ORDER BY updated_at DESC LIMIT 100`,
      [tenantId, ownerId],
    );
    return r.rows;
  }

  async getDraft(tenantId: string, ownerId: string, id: string): Promise<DraftRow | null> {
    const r = await this.pool.query<DraftRow>(
      `SELECT id, step, answers, created_at, updated_at FROM demo.drafts
       WHERE tenant_id = $1 AND owner_id = $2 AND id = $3`,
      [tenantId, ownerId, id],
    );
    return r.rows[0] ?? null;
  }

  /** Creates the draft, or replaces its answers when it exists. Returns true when it was created, null when the id belongs to someone else. */
  async saveDraft(tenantId: string, ownerId: string, id: string, step: number, answers: unknown): Promise<boolean | null> {
    const r = await this.pool.query<{ created: boolean }>(
      `INSERT INTO demo.drafts (id, tenant_id, owner_id, step, answers) VALUES ($3, $1, $2, $4, $5)
       ON CONFLICT (id) DO UPDATE SET step = EXCLUDED.step, answers = EXCLUDED.answers, updated_at = now()
         WHERE demo.drafts.tenant_id = $1 AND demo.drafts.owner_id = $2
       RETURNING (xmax = 0) AS created`,
      [tenantId, ownerId, id, step, JSON.stringify(answers)],
    );
    return r.rows[0]?.created ?? null;
  }

  async deleteDraft(tenantId: string, ownerId: string, id: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM demo.drafts WHERE tenant_id = $1 AND owner_id = $2 AND id = $3', [tenantId, ownerId, id]);
    return (r.rowCount ?? 0) === 1;
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

  /** What waits for a human, exact and uncapped, in one statement. `keptBack` is 0 unless `includeSuspected`. */
  async pendingCounts(tenantId: string, includeSuspected: boolean): Promise<PendingCounts> {
    const r = await this.pool.query<Record<keyof PendingCounts, number>>(
      `SELECT (SELECT count(*) FROM demo.assessment_requests
                 WHERE tenant_id = $1 AND status = 'pending_gate1')::int AS "gate1",
              (SELECT count(*) FROM demo.gate2_requests
                 WHERE tenant_id = $1 AND status = 'pending' AND deadline_at > now())::int AS "gate2",
              (SELECT count(*) FROM demo.findings WHERE tenant_id = $1 AND status = 'confirmed')::int AS "gate3",
              (CASE WHEN $2 THEN (SELECT count(*) FROM demo.findings WHERE tenant_id = $1 AND status = 'suspected')
                 ELSE 0 END)::int AS "keptBack",
              (SELECT count(*) FROM demo.runs WHERE tenant_id = $1 AND state = ANY($3))::int AS "live"`,
      [tenantId, includeSuspected, LIVE_STATES],
    );
    const row = r.rows[0];
    return {
      gate1: row?.gate1 ?? 0,
      gate2: row?.gate2 ?? 0,
      gate3: row?.gate3 ?? 0,
      keptBack: row?.keptBack ?? 0,
      live: row?.live ?? 0,
    };
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

  async insertEmergencyLink(row: {
    id: string;
    tenant_id: string;
    token_hash: Buffer;
    label: string | null;
    created_by: string;
    created_by_name: string;
    expires_at: Date;
  }): Promise<EmergencyLinkRow> {
    const r = await this.pool.query<EmergencyLinkRow>(
      `INSERT INTO demo.emergency_links (id, tenant_id, token_hash, label, created_by, created_by_name, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [row.id, row.tenant_id, row.token_hash, row.label, row.created_by, row.created_by_name, row.expires_at],
    );
    const inserted = r.rows[0];
    if (inserted === undefined) throw new Error('emergency link insert returned nothing');
    return inserted;
  }

  /** Links that still work: not revoked and not expired, newest first. */
  async listActiveEmergencyLinks(tenantId: string): Promise<EmergencyLinkRow[]> {
    const r = await this.pool.query<EmergencyLinkRow>(
      `SELECT * FROM demo.emergency_links
       WHERE tenant_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      [tenantId],
    );
    return r.rows;
  }

  /** The link with this token hash, whatever its state (the service decides whether it still works). */
  async findEmergencyLink(tenantId: string, tokenHash: Buffer): Promise<EmergencyLinkRow | null> {
    const r = await this.pool.query<EmergencyLinkRow>(
      'SELECT * FROM demo.emergency_links WHERE tenant_id = $1 AND token_hash = $2',
      [tenantId, tokenHash],
    );
    return r.rows[0] ?? null;
  }

  /** Revokes a link that still works. Null when it is unknown, expired or already revoked. */
  async revokeEmergencyLink(tenantId: string, id: string, by: string): Promise<EmergencyLinkRow | null> {
    const r = await this.pool.query<EmergencyLinkRow>(
      `UPDATE demo.emergency_links SET revoked_at = now(), revoked_by = $3
       WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL AND expires_at > now() RETURNING *`,
      [tenantId, id, by],
    );
    return r.rows[0] ?? null;
  }

  async touchEmergencyLink(tenantId: string, id: string): Promise<void> {
    await this.pool.query(
      'UPDATE demo.emergency_links SET last_used_at = now() WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
  }

  async getEmergencyContact(tenantId: string): Promise<EmergencyContact | null> {
    const r = await this.pool.query<{ name: string | null; phone: string | null }>(
      `SELECT emergency_contact_name AS name, emergency_contact_phone AS phone
       FROM demo.workspace_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    const { name = null, phone = null } = r.rows[0] ?? {};
    return name === null || phone === null ? null : { name, phone };
  }

  /** Sets (or, with null, clears) the emergency contact. */
  async setEmergencyContact(tenantId: string, contact: EmergencyContact | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO demo.workspace_settings (tenant_id, emergency_contact_name, emergency_contact_phone)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET emergency_contact_name = $2, emergency_contact_phone = $3,
         updated_at = now()`,
      [tenantId, contact?.name ?? null, contact?.phone ?? null],
    );
  }
}
