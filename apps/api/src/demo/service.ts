// DEMO-STORY business rules: assets and ownership proof, assessment requests, Gate 1 (separation of duties),
// run start and control (pause, kill), Gate 2 decisions and finding reads. The hunt itself runs in the worker.
import { randomBytes } from 'node:crypto';

import { HttpException, HttpStatus, Logger } from '@nestjs/common';

import { newId } from '@blackwing/ids';

import { verifyChain, type AuditPayload, type AuditRef, type ChainState } from './audit.js';

import type {
  AssetRow,
  DemoStore,
  ExchangeRow,
  FindingRow,
  Gate2Row,
  RequestRow,
  RunRow,
} from './store.js';

/** Identity forwarded by the web server from the signed-in Google session (internal hop only). */
export interface DemoActor {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: readonly string[];
  /** An administrator (BW_ADMIN_EMAILS): holds every role and may approve its own requests. */
  readonly admin?: boolean;
}

/** Every demo role, held by the admin. */
export const ALL_ROLES = [
  'appsec-engineer',
  'asset-owner',
  'developer',
  'org-admin',
  'auditor',
] as const;

/** A stable, machine-readable refusal (RFC 9457 problem body, `code` is the registered name). */
export class DemoRefusal extends HttpException {
  constructor(status: number, code: string, detail: string) {
    super({ type: `urn:blackwing:demo:${code}`, title: code, status, code, detail }, status);
  }
}

export const INTRUSIVENESS = ['passive', 'active_safe'] as const;

const WELL_KNOWN_PATH = '/.well-known/blackwing-verification.txt';
const VERIFY_TIMEOUT_MS = 5000;
const RECENT_ITEMS = 10;
const FINDING_LIST_LIMIT = 200;
const AUDIT_LIST_LIMIT = 200;
const WEBHOOK_TIMEOUT_MS = 5000;
const SHORT_ID_LENGTH = 8;
const MS_PER_SECOND = 1000;
const TOKEN_BYTES = 16;
const SLUG_MAX = 40;

/** Normalises a role name (Keycloak uses dashes, the seed uses underscores). */
function normaliseRole(role: string): string {
  return role.trim().toLowerCase().replace(/_/g, '-');
}

export function actorHasRole(actor: DemoActor, role: string): boolean {
  const wanted = normaliseRole(role);
  return actor.roles.some((r) => normaliseRole(r) === wanted);
}

function requireRole(actor: DemoActor, roles: readonly string[], detail: string): void {
  if (!roles.some((role) => actorHasRole(actor, role))) {
    throw new DemoRefusal(HttpStatus.FORBIDDEN, 'role_required', detail);
  }
}

/** The run id as people type and read it (kill confirmation, breadcrumbs). */
export const shortId = (id: string): string => id.slice(0, SHORT_ID_LENGTH);

/** `scheme://host[:port]` of each URL, without duplicates. */
export function originsOf(urls: readonly string[]): string[] {
  return [...new Set(urls.map((url) => new URL(url).origin))];
}

export function secondsLeft(deadline: Date, now: Date): number {
  return Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / MS_PER_SECOND));
}

/** The severity column is jsonb: the worker may write a bare level or `{level}`. */
function severityOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const level = (value as { level?: unknown } | null)?.level;
  return typeof level === 'string' ? level : 'info';
}

/** Gate 3 transitions: where a finding may come from for each decision. */
const TRIAGE_FROM = {
  release: ['suspected', 'confirmed'],
  dismiss: ['suspected', 'confirmed', 'released'],
} as const;

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function assetDto(row: AssetRow): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    baseUrl: row.base_url,
    allowedOrigins: row.allowed_origins,
    excludedPaths: row.excluded_paths,
    ownership: {
      status: row.ownership_status,
      method: row.verification_method,
      verifiedBy: row.verified_by_name,
      verifiedAt: iso(row.verified_at),
    },
    verification: {
      token: row.verification_token,
      wellKnownUrl: `${new URL(row.base_url).origin}${WELL_KNOWN_PATH}`,
    },
    createdAt: row.created_at.toISOString(),
  };
}

export function requestDto(row: RequestRow): Record<string, unknown> {
  return {
    id: row.id,
    assetId: row.asset_id,
    assetName: row.asset_name,
    objective: row.objective,
    excludedPaths: row.scope.excludedPaths ?? [],
    intrusiveness: row.intrusiveness,
    budget: {
      requests: row.budget_requests,
      seconds: row.budget_seconds,
      costUsd: Number(row.cost_cap_usd),
    },
    status: row.status,
    requester: { id: row.requester_id, name: row.requester_name },
    approver: row.approver_id === null ? null : { id: row.approver_id, name: row.approver_name },
    testAccounts: row.test_accounts.map((a) => ({ role: a.role, headerName: a.header_name })),
    decisionReason: row.decision_reason,
    decidedAt: iso(row.decided_at),
    createdAt: row.created_at.toISOString(),
    runId: null,
  };
}

export function runDto(row: RunRow): Record<string, unknown> {
  return {
    id: row.id,
    shortId: shortId(row.id),
    requestId: row.request_id,
    assetName: row.asset_name,
    state: row.state,
    paused: row.paused,
    costUsd: Number(row.cost_usd),
    requestsUsed: row.requests_used,
    budget: {
      requests: row.budget_requests,
      seconds: row.budget_seconds,
      costUsd: Number(row.cost_cap_usd),
    },
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    killRequestedAt: iso(row.kill_requested_at),
    haltMs: row.halt_ms,
    summary: row.summary,
    pins: row.pins,
  };
}

/** The fields a list needs; the full evidence is in {@link findingDto}. */
export function findingSummaryDto(row: FindingRow): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    assetId: row.asset_id,
    assetName: row.asset_name,
    title: row.title,
    status: row.status,
    severity: severityOf(row.severity),
    cwe: row.cwe_id,
    owasp: row.owasp_category,
    agent: row.agent,
    createdAt: row.created_at.toISOString(),
  };
}

export function findingDto(
  row: FindingRow,
  audit: AuditRef | null = null,
): Record<string, unknown> {
  return {
    ...findingSummaryDto(row),
    class: row.class,
    confidence: Number(row.confidence),
    description: row.description,
    oracle: row.oracle,
    evidence: row.evidence,
    replay: row.replay,
    reproCurl: row.repro_curl,
    testCaseId: row.test_case_id,
    location: row.location,
    triage:
      row.triaged_at === null
        ? null
        : { at: row.triaged_at.toISOString(), by: row.triaged_by_name, reason: row.triage_reason },
    delivery:
      row.delivery_status === null || row.delivered_at === null
        ? null
        : {
            status: row.delivery_status,
            detail: row.delivery_detail ?? '',
            at: row.delivered_at.toISOString(),
          },
    audit,
  };
}

export function exchangeDto(row: ExchangeRow): Record<string, unknown> {
  return {
    id: row.id,
    seq: row.seq,
    agent: row.agent,
    method: row.method,
    url: row.url,
    requestHeaders: row.request_headers,
    requestBody: row.request_body,
    status: row.status,
    responseHeaders: row.response_headers,
    responseBody: row.response_body,
    durationMs: row.duration_ms,
    outcome: row.outcome,
    reason: row.reason,
    at: row.at.toISOString(),
  };
}

export function gate2Dto(row: Gate2Row, now: Date): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    agent: row.agent,
    method: row.method,
    url: row.url,
    pathKey: row.path_key,
    intrusiveness: row.intrusiveness,
    reason: row.reason,
    whyOutside: row.why_outside,
    status: row.status,
    deadlineAt: row.deadline_at.toISOString(),
    secondsLeft: row.status === 'pending' ? secondsLeft(row.deadline_at, now) : 0,
    decidedBy: row.decided_by_name,
    decisionReason: row.decision_reason,
    decidedAt: iso(row.decided_at),
    createdAt: row.created_at.toISOString(),
  };
}

export interface CreateAssetInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly extraOrigins: readonly string[];
  readonly excludedPaths: readonly string[];
}

export interface VerifyInput {
  readonly method: 'http_token' | 'owner_attestation';
}

export interface CreateRequestInput {
  readonly assetId: string;
  readonly objective: string;
  readonly intrusiveness: (typeof INTRUSIVENESS)[number];
  readonly budgetRequests: number;
  readonly budgetSeconds: number;
  readonly costCapUsd: number;
  readonly excludedPaths: readonly string[];
  readonly testAccounts: readonly { role: string; headerName: string; headerValue: string }[];
}

export interface WebhookOptions {
  readonly webhookUrl: string | null;
  readonly consoleOrigin: string;
}

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

export class DemoService {
  private readonly logger = new Logger('DemoService');

  constructor(
    private readonly store: DemoStore,
    private readonly tenantId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly webhook: WebhookOptions = {
      webhookUrl: null,
      consoleOrigin: 'http://localhost:3000',
    },
  ) {}

  private audit(
    actor: DemoActor,
    action: string,
    targetType: string,
    targetId: string,
    payload: AuditPayload,
  ): Promise<AuditRef> {
    return this.store.appendAudit(this.tenantId, {
      actorId: actor.id,
      actorName: actor.name,
      action,
      targetType,
      targetId,
      payload,
    });
  }

  async assets(): Promise<Record<string, unknown>[]> {
    return (await this.store.listAssets(this.tenantId)).map((row) => assetDto(row));
  }

  async asset(id: string): Promise<Record<string, unknown>> {
    return assetDto(await this.assetRow(id));
  }

  private async assetRow(id: string): Promise<AssetRow> {
    const row = await this.store.getAsset(this.tenantId, id);
    if (row === null)
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'asset_not_found', 'No such asset.');
    return row;
  }

  async createAsset(actor: DemoActor, input: CreateAssetInput): Promise<Record<string, unknown>> {
    requireRole(actor, ['appsec-engineer'], 'Only an appsec engineer can register an asset.');
    const origin = new URL(input.baseUrl).origin;
    const existing = (await this.store.listAssets(this.tenantId)).find(
      (a) => new URL(a.base_url).origin === origin,
    );
    if (existing !== undefined) return assetDto(existing);
    const id = newId();
    const slug = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, SLUG_MAX);
    await this.store.insertAsset({
      id,
      tenant_id: this.tenantId,
      slug: `${slug}-${shortId(id)}`,
      name: input.name,
      base_url: input.baseUrl,
      allowed_origins: originsOf([input.baseUrl, ...input.extraOrigins]),
      excluded_paths: [...input.excludedPaths],
      verification_token: randomBytes(TOKEN_BYTES).toString('hex'),
      created_by: actor.id,
    });
    return this.asset(id);
  }

  /** The asset owner proves control by serving the token, or attests authority (lab or owned system). */
  async verifyAsset(
    actor: DemoActor,
    id: string,
    input: VerifyInput,
  ): Promise<Record<string, unknown>> {
    requireRole(actor, ['asset-owner'], 'Only an asset owner can verify ownership.');
    const asset = await this.assetRow(id);
    if (asset.ownership_status === 'verified') {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'already_verified',
        'Ownership is already verified.',
      );
    }
    if (input.method === 'http_token') await this.checkWellKnownToken(asset);
    if (!(await this.store.markAssetVerified(this.tenantId, id, input.method, actor.id))) {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'already_verified',
        'Ownership was verified concurrently.',
      );
    }
    return this.asset(id);
  }

  private async checkWellKnownToken(asset: AssetRow): Promise<void> {
    const url = `${new URL(asset.base_url).origin}${WELL_KNOWN_PATH}`;
    let body = '';
    try {
      const response = await this.fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (response.ok) body = await response.text();
    } catch {
      body = '';
    }
    if (asset.verification_token === null || !body.includes(asset.verification_token)) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'verification_failed',
        `${url} did not answer 200 with the verification token.`,
      );
    }
  }

  async dashboard(actor: DemoActor): Promise<Record<string, unknown>> {
    const [counts, assets, requests, runs, findings, pending] = await Promise.all([
      this.store.dashboardCounts(this.tenantId),
      this.store.listAssets(this.tenantId),
      this.store.listPendingGate1(this.tenantId),
      this.store.listRuns(this.tenantId, RECENT_ITEMS),
      this.store.listFindings(this.tenantId, RECENT_ITEMS, actorHasRole(actor, 'appsec-engineer')),
      this.store.listPendingGate2(this.tenantId),
    ]);
    const now = new Date();
    return {
      tenant: { id: this.tenantId },
      actor: { id: actor.id, name: actor.name, roles: actor.roles },
      counts: { ...counts, gate2Pending: pending.length },
      assets: assets.slice(0, RECENT_ITEMS).map((row) => assetDto(row)),
      requests: requests.map((row) => requestDto(row)),
      runs: runs.map((row) => runDto(row)),
      findings: findings.map((row) => findingSummaryDto(row)),
      pendingGate2: pending.map((row) => gate2Dto(row, now)),
    };
  }

  async createRequest(
    actor: DemoActor,
    input: CreateRequestInput,
  ): Promise<Record<string, unknown>> {
    requireRole(actor, ['appsec-engineer'], 'Only an appsec engineer can request an assessment.');
    const asset = await this.assetRow(input.assetId);
    if (asset.ownership_status !== 'verified') {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'asset_not_verified',
        'Ownership must be verified before an assessment can be requested.',
      );
    }
    const id = newId();
    await this.store.insertRequest({
      id,
      tenant_id: this.tenantId,
      asset_id: asset.id,
      requester_id: actor.id,
      objective: input.objective,
      scope: { excludedPaths: [...input.excludedPaths] },
      intrusiveness: input.intrusiveness,
      budget_requests: input.budgetRequests,
      budget_seconds: input.budgetSeconds,
      cost_cap_usd: input.costCapUsd,
      test_accounts: input.testAccounts.map((a) => ({
        role: a.role,
        header_name: a.headerName,
        header_value: a.headerValue,
      })),
    });
    return this.request(id);
  }

  /** `audit` is the event just appended by a decision; a plain read looks up the latest one. */
  async request(
    id: string,
    viewer?: DemoActor,
    audit?: AuditRef,
  ): Promise<Record<string, unknown>> {
    const row = await this.store.getRequest(this.tenantId, id);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such request.');
    const run = await this.store.findRunByRequest(this.tenantId, id);
    return {
      ...requestDto(row),
      runId: run?.id ?? null,
      viewerIsRequester: viewer?.id === row.requester_id,
      viewerIsAdmin: viewer?.admin === true,
      selfApproved: row.approver_id !== null && row.approver_id === row.requester_id,
      audit: audit ?? (await this.store.latestAudit(this.tenantId, 'request', id)),
    };
  }

  /** Gate 1: a second user approves. Only the demo admin may approve its own request, and the audit says so. */
  async decideGate1(
    actor: DemoActor,
    requestId: string,
    decision: 'approve' | 'reject',
    reason: string | null,
  ): Promise<Record<string, unknown>> {
    const row = await this.store.getRequest(this.tenantId, requestId);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such request.');
    if (row.status !== 'pending_gate1') {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'request_not_pending',
        `The request is ${row.status}; Gate 1 is already decided.`,
      );
    }
    const selfApproved = actor.id === row.requester_id;
    if (selfApproved && actor.admin !== true) {
      throw new DemoRefusal(
        HttpStatus.FORBIDDEN,
        'separation_of_duties',
        'Separation of duties: the requester cannot approve their own request at Gate 1. Sign in as a second user (asset owner).',
      );
    }
    requireRole(actor, ['asset-owner'], 'Only an asset owner can decide Gate 1.');
    const ok = await this.store.decideRequest(
      this.tenantId,
      requestId,
      actor.id,
      decision === 'approve' ? 'approved' : 'rejected',
      reason,
    );
    if (!ok) {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'request_not_pending',
        'Gate 1 was decided concurrently.',
      );
    }
    const audit = await this.audit(actor, `gate1.${decision}`, 'request', requestId, {
      decision,
      reason,
      selfApproved,
      override: selfApproved ? 'admin' : null,
    });
    return this.request(requestId, actor, audit);
  }

  async startRun(actor: DemoActor, requestId: string): Promise<Record<string, unknown>> {
    requireRole(actor, ['appsec-engineer'], 'Only an appsec engineer starts a run.');
    const row = await this.store.getRequest(this.tenantId, requestId);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such request.');
    if (row.status !== 'approved') {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'gate1_not_approved',
        `The request is ${row.status}; a run needs Gate 1 approval first.`,
      );
    }
    const asset = await this.assetRow(row.asset_id);
    if (asset.ownership_status !== 'verified') {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'asset_not_verified',
        'Asset ownership is not verified.',
      );
    }
    if (!(await this.store.claimRequestForRun(this.tenantId, requestId))) {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'run_already_started',
        'This request already has a run.',
      );
    }
    const runId = newId();
    const pins = {
      asset: {
        id: asset.id,
        name: asset.name,
        baseUrl: asset.base_url,
        allowedOrigins: asset.allowed_origins,
        excludedPaths: [...new Set([...asset.excluded_paths, ...(row.scope.excludedPaths ?? [])])],
      },
      request: {
        id: row.id,
        objective: row.objective,
        intrusiveness: row.intrusiveness,
        budget: {
          requests: row.budget_requests,
          seconds: row.budget_seconds,
          costUsd: Number(row.cost_cap_usd),
        },
        testAccounts: row.test_accounts.map((a) => ({ role: a.role, headerName: a.header_name })),
        requesterId: row.requester_id,
        approverId: row.approver_id,
        decidedAt: iso(row.decided_at),
      },
      authorisation: {
        saId: `SA-${row.id.slice(0, SHORT_ID_LENGTH).toUpperCase()}`,
        signedBy: row.approver_name,
        keyId: 'bw-sa-key',
      },
      runner: { name: 'ai-hunt', version: '1' },
    };
    await this.store.insertRun({
      id: runId,
      tenant_id: this.tenantId,
      request_id: requestId,
      created_by: actor.id,
      pins,
      budget_requests: row.budget_requests,
    });
    await this.store.appendEvent(runId, {
      kind: 'run.queued',
      stage: 'queued',
      message: 'Run accepted. Scope, budgets and authorisation pinned.',
    });
    return { id: runId, requestId, state: 'queued' };
  }

  private async runRow(runId: string): Promise<RunRow> {
    const row = await this.store.getRun(this.tenantId, runId);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such run.');
    return row;
  }

  async run(actor: DemoActor, runId: string, afterSeq: number): Promise<Record<string, unknown>> {
    const row = await this.runRow(runId);
    const analyst = actorHasRole(actor, 'appsec-engineer');
    const [events, findings, gate2, stats] = await Promise.all([
      this.store.listEvents(runId, afterSeq),
      this.store.listFindingsForRun(this.tenantId, runId, analyst),
      this.store.listGate2ForRun(this.tenantId, runId),
      this.store.runStats(runId),
    ]);
    const now = new Date();
    return {
      ...runDto(row),
      lastSeq: events.at(-1)?.seq ?? afterSeq,
      // Suspected findings are for analysts only, so their events are too.
      events: events
        .filter((e) => analyst || e.kind !== 'finding.suspected')
        .map((e) => ({
          seq: e.seq,
          kind: e.kind,
          stage: e.stage,
          message: e.message,
          data: e.data,
          at: e.at.toISOString(),
        })),
      findings: findings.map((f) => findingSummaryDto(f)),
      gate2: gate2.map((g) => gate2Dto(g, now)),
      stats,
    };
  }

  async exchanges(runId: string, afterSeq: number): Promise<Record<string, unknown>> {
    await this.runRow(runId);
    const items = await this.store.listExchanges(runId, afterSeq);
    return { items: items.map((row) => exchangeDto(row)), lastSeq: items.at(-1)?.seq ?? afterSeq };
  }

  async setPaused(
    actor: DemoActor,
    runId: string,
    paused: boolean,
  ): Promise<Record<string, unknown>> {
    requireRole(
      actor,
      ['appsec-engineer', 'asset-owner'],
      'Only an appsec engineer or an asset owner controls a run.',
    );
    await this.runRow(runId);
    if (!(await this.store.setPaused(this.tenantId, runId, paused))) {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'run_not_controllable',
        `The run is finished or already ${paused ? 'paused' : 'running'}.`,
      );
    }
    await this.store.appendEvent(runId, {
      kind: paused ? 'run.paused' : 'run.resumed',
      stage: 'control',
      message: `Run ${paused ? 'paused' : 'resumed'} by ${actor.name}.`,
      data: { by: actor.id },
    });
    return runDto(await this.runRow(runId));
  }

  /** Any tenant user may kill. A queued run is killed here; a running one is flagged and the worker halts it. */
  async kill(
    actor: DemoActor,
    runId: string,
    confirm: string,
  ): Promise<{ killRequestedAt: string; audit: AuditRef }> {
    const run = await this.runRow(runId);
    if (confirm.trim().toLowerCase() !== shortId(run.id).toLowerCase()) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'kill_confirmation_mismatch',
        `Type the run id ${shortId(run.id)} to confirm.`,
      );
    }
    const killedQueued = await this.store.killQueuedRun(this.tenantId, runId, actor.id);
    if (killedQueued !== null) {
      await this.store.appendEvent(runId, {
        kind: 'run.killed',
        stage: 'control',
        message: `Run killed by ${actor.name} before it started.`,
        data: { by: actor.id, haltMs: 0 },
      });
      const audit = await this.audit(actor, 'run.kill', 'run', runId, { confirm, queued: true });
      return { killRequestedAt: killedQueued.toISOString(), audit };
    }
    const requestedAt = await this.store.requestKill(this.tenantId, runId, actor.id);
    if (requestedAt === null) {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'run_not_running',
        'The run is not queued or running.',
      );
    }
    await this.store.appendEvent(runId, {
      kind: 'kill.requested',
      stage: 'control',
      message: `Kill requested by ${actor.name}.`,
      data: { by: actor.id },
    });
    const audit = await this.audit(actor, 'run.kill', 'run', runId, { confirm, queued: false });
    return { killRequestedAt: requestedAt.toISOString(), audit };
  }

  /** `audit` is the event just appended by a decision; a plain read looks up the latest one. */
  async gate2(id: string, audit?: AuditRef): Promise<Record<string, unknown>> {
    const row = await this.gate2Row(id);
    const run = await this.runRow(row.run_id);
    return {
      ...gate2Dto(row, new Date()),
      audit: audit ?? (await this.store.latestAudit(this.tenantId, 'gate2', id)),
      run: {
        id: run.id,
        shortId: shortId(run.id),
        state: run.state,
        assetName: run.asset_name,
        pins: run.pins,
      },
    };
  }

  private async gate2Row(id: string): Promise<Gate2Row> {
    const row = await this.store.getGate2(this.tenantId, id);
    if (row === null)
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such Gate 2 request.');
    return row;
  }

  /** No decision before the deadline means denied: the worker treats a late or missing decision as a refusal. */
  async decideGate2(
    actor: DemoActor,
    id: string,
    decision: 'approve' | 'deny',
    reason: string | null,
  ): Promise<Record<string, unknown>> {
    requireRole(
      actor,
      ['asset-owner', 'appsec-engineer'],
      'Only an asset owner or an appsec engineer decides Gate 2.',
    );
    const row = await this.gate2Row(id);
    const run = await this.runRow(row.run_id);
    if (run.state === 'killed') {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'gate2_closed',
        'The run was killed; nothing can be approved.',
      );
    }
    const selfApproved =
      (await this.store.getRequest(this.tenantId, run.request_id))?.requester_id === actor.id;
    const status = decision === 'approve' ? 'approved' : 'denied';
    if (!(await this.store.decideGate2(this.tenantId, id, status, actor.id, reason))) {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'gate2_closed',
        'The request is already decided or past its deadline.',
      );
    }
    const audit = await this.audit(actor, `gate2.${decision}`, 'gate2', id, {
      decision,
      reason,
      method: row.method,
      url: row.url,
      runId: row.run_id,
      selfApproved,
      override: selfApproved ? 'admin' : null,
    });
    return this.gate2(id, audit);
  }

  /** A suspected finding is for analysts only: anyone else gets the same 404 as for a missing one. */
  async finding(actor: DemoActor, id: string): Promise<FindingRow> {
    const row = await this.store.getFinding(this.tenantId, id);
    if (row === null || (row.status === 'suspected' && !actorHasRole(actor, 'appsec-engineer'))) {
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such finding.');
    }
    return row;
  }

  async findingDetail(
    actor: DemoActor,
    id: string,
    audit?: AuditRef,
  ): Promise<Record<string, unknown>> {
    const row = await this.finding(actor, id);
    return findingDto(row, audit ?? (await this.store.latestAudit(this.tenantId, 'finding', id)));
  }

  /** Context the report needs: the finding, its run, asset and request. Only released findings are reported. */
  async reportContext(
    actor: DemoActor,
    findingId: string,
  ): Promise<{
    finding: FindingRow;
    run: RunRow;
    asset: AssetRow;
    request: RequestRow;
  }> {
    const finding = await this.finding(actor, findingId);
    if (finding.status !== 'released') {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'finding_not_released',
        'Only released findings are reported.',
      );
    }
    const run = await this.runRow(finding.run_id);
    return { finding, run, ...(await this.runContext(run)) };
  }

  private async runContext(run: RunRow): Promise<{ asset: AssetRow; request: RequestRow }> {
    const request = await this.store.getRequest(this.tenantId, run.request_id);
    const asset =
      request === null ? null : await this.store.getAsset(this.tenantId, request.asset_id);
    if (request === null || asset === null) {
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'The run has no request or asset.');
    }
    return { asset, request };
  }

  /** Context the run report needs: the run, its asset and request, and its released findings only. */
  async runReportContext(runId: string): Promise<{
    run: RunRow;
    asset: AssetRow;
    request: RequestRow;
    findings: FindingRow[];
  }> {
    const run = await this.runRow(runId);
    const findings = (await this.store.listFindingsForRun(this.tenantId, runId, false)).filter(
      (f) => f.status === 'released',
    );
    return { run, ...(await this.runContext(run)), findings };
  }

  async listFindings(actor: DemoActor): Promise<Record<string, unknown>[]> {
    const rows = await this.store.listFindings(
      this.tenantId,
      FINDING_LIST_LIMIT,
      actorHasRole(actor, 'appsec-engineer'),
    );
    return rows.map((row) => findingSummaryDto(row));
  }

  /** Gate 3: an AppSec engineer releases or dismisses a finding with a reason. A release is delivered to the webhook. */
  async triage(
    actor: DemoActor,
    id: string,
    decision: 'release' | 'dismiss',
    reason: string,
  ): Promise<Record<string, unknown>> {
    requireRole(
      actor,
      ['appsec-engineer'],
      'Only an AppSec engineer can release or dismiss a finding.',
    );
    const finding = await this.finding(actor, id);
    const to = decision === 'release' ? 'released' : 'dismissed';
    if (
      !(await this.store.triageFinding(
        this.tenantId,
        id,
        TRIAGE_FROM[decision],
        to,
        actor.id,
        reason,
      ))
    ) {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'finding_not_triageable',
        `A ${finding.status} finding cannot be ${to}.`,
      );
    }
    const audit = await this.audit(actor, `finding.${decision}`, 'finding', id, {
      decision,
      reason,
      runId: finding.run_id,
    });
    const severity = severityOf(finding.severity);
    await this.store.appendEvent(finding.run_id, {
      kind: `finding.${to}`,
      stage: 'gate3',
      message: `${capitalise(to)} by ${actor.name}: ${finding.title}`,
      data: {
        findingId: id,
        title: finding.title,
        severity,
        ...(decision === 'release' ? { auto: false } : {}),
        by: actor.id,
        reason,
      },
    });
    if (decision === 'release') await this.deliver(finding, actor.name);
    return this.findingDetail(actor, id, audit);
  }

  /** POSTs the released finding to the optional webhook and records the result. A failure never fails the release. */
  private async deliver(finding: FindingRow, releasedBy: string): Promise<void> {
    const { webhookUrl, consoleOrigin } = this.webhook;
    if (webhookUrl === null) return;
    const url = `${consoleOrigin}/findings/${finding.id}`;
    const severity = severityOf(finding.severity);
    const asset = finding.asset_name ?? '';
    const body = {
      text: `Blackwing released a ${capitalise(severity)} finding on ${asset}: ${finding.title}. ${url}`,
      finding: {
        id: finding.id,
        title: finding.title,
        severity,
        cwe: finding.cwe_id,
        owasp: finding.owasp_category,
        asset,
        url,
        reproCurl: finding.repro_curl,
        releasedBy,
      },
    };
    let status: 'delivered' | 'failed';
    let detail: string;
    try {
      const response = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      status = response.ok ? 'delivered' : 'failed';
      detail = `HTTP ${response.status}`;
    } catch (error) {
      status = 'failed';
      detail = error instanceof Error ? error.name : 'Error';
    }
    if (status === 'failed') this.logger.warn({ event: 'demo.webhook.failed', reason: detail });
    await this.store.recordDelivery(finding.id, status, detail);
  }

  /** The latest ledger events (newest first) and the verification of the whole chain. */
  async auditLedger(): Promise<{ items: Record<string, unknown>[]; chain: ChainState }> {
    const rows = await this.store.listAudit(this.tenantId);
    const items = rows
      .slice(-AUDIT_LIST_LIMIT)
      .reverse()
      .map((r) => ({
        eventId: r.eventId,
        seq: r.seq,
        at: r.at.toISOString(),
        actor: { id: r.actorId, name: r.actorName },
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        payload: r.payload,
        prevHash: r.prevHash,
        hash: r.hash,
      }));
    return { items, chain: verifyChain(rows) };
  }
}
