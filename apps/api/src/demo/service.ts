// DEMO-STORY business rules: assets and ownership proof, assessment requests, Gate 1 (separation of duties),
// run start and control (pause, kill), Gate 2 decisions and finding reads. The hunt itself runs in the worker.
import { randomBytes } from 'node:crypto';

import { HttpException, HttpStatus } from '@nestjs/common';

import { newId } from '@blackwing/ids';

import type {
  AssetRow,
  DemoStore,
  ExchangeRow,
  FindingRow,
  Gate2Row,
  RequestRow,
  RunRow,
} from './store.js';

/** Identity forwarded by the demo web server from the Keycloak session (internal hop only). */
export interface DemoActor {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: readonly string[];
}

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
const FINDING_LIST_LIMIT = 50;
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
    objective: row.objective,
    excludedPaths: row.scope.excludedPaths ?? [],
    intrusiveness: row.intrusiveness,
    budget: { requests: row.budget_requests, seconds: row.budget_seconds, costUsd: Number(row.cost_cap_usd) },
    status: row.status,
    requester: { id: row.requester_id, name: row.requester_name },
    approver: row.approver_id === null ? null : { id: row.approver_id, name: row.approver_name },
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
    budget: { requests: row.budget_requests, seconds: row.budget_seconds, costUsd: Number(row.cost_cap_usd) },
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
    title: row.title,
    status: row.status,
    severity: severityOf(row.severity),
    cwe: row.cwe_id,
    owasp: row.owasp_category,
    agent: row.agent,
    createdAt: row.created_at.toISOString(),
  };
}

export function findingDto(row: FindingRow): Record<string, unknown> {
  return {
    ...findingSummaryDto(row),
    class: row.class,
    confidence: Number(row.confidence),
    description: row.description,
    oracle: row.oracle,
    evidence: row.evidence,
    replay: row.replay,
    reproCurl: row.repro_curl,
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
}

export class DemoService {
  constructor(
    private readonly store: DemoStore,
    private readonly tenantId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async assets(): Promise<Record<string, unknown>[]> {
    return (await this.store.listAssets(this.tenantId)).map((row) => assetDto(row));
  }

  async asset(id: string): Promise<Record<string, unknown>> {
    return assetDto(await this.assetRow(id));
  }

  private async assetRow(id: string): Promise<AssetRow> {
    const row = await this.store.getAsset(this.tenantId, id);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'asset_not_found', 'No such asset.');
    return row;
  }

  async createAsset(actor: DemoActor, input: CreateAssetInput): Promise<Record<string, unknown>> {
    requireRole(actor, ['appsec-engineer'], 'Only an appsec engineer can register an asset.');
    const id = newId();
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, SLUG_MAX);
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
  async verifyAsset(actor: DemoActor, id: string, input: VerifyInput): Promise<Record<string, unknown>> {
    requireRole(actor, ['asset-owner'], 'Only an asset owner can verify ownership.');
    const asset = await this.assetRow(id);
    if (asset.ownership_status === 'verified') {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'already_verified', 'Ownership is already verified.');
    }
    if (input.method === 'http_token') await this.checkWellKnownToken(asset);
    if (!(await this.store.markAssetVerified(this.tenantId, id, input.method, actor.id))) {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'already_verified', 'Ownership was verified concurrently.');
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
      this.store.listRequests(this.tenantId, RECENT_ITEMS),
      this.store.listRuns(this.tenantId, RECENT_ITEMS),
      this.store.listFindings(this.tenantId, RECENT_ITEMS),
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

  async createRequest(actor: DemoActor, input: CreateRequestInput): Promise<Record<string, unknown>> {
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
    });
    return this.request(id);
  }

  async request(id: string, viewerId?: string): Promise<Record<string, unknown>> {
    const row = await this.store.getRequest(this.tenantId, id);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such request.');
    const run = await this.store.findRunByRequest(this.tenantId, id);
    return { ...requestDto(row), runId: run?.id ?? null, viewerIsRequester: viewerId === row.requester_id };
  }

  /** Gate 1: a second user approves. The requester can never approve their own request (SoD). */
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
    if (actor.id === row.requester_id) {
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
      throw new DemoRefusal(HttpStatus.CONFLICT, 'request_not_pending', 'Gate 1 was decided concurrently.');
    }
    return this.request(requestId);
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
      throw new DemoRefusal(HttpStatus.UNPROCESSABLE_ENTITY, 'asset_not_verified', 'Asset ownership is not verified.');
    }
    if (!(await this.store.claimRequestForRun(this.tenantId, requestId))) {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'run_already_started', 'This request already has a run.');
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
        budget: { requests: row.budget_requests, seconds: row.budget_seconds, costUsd: Number(row.cost_cap_usd) },
        requesterId: row.requester_id,
        approverId: row.approver_id,
        decidedAt: iso(row.decided_at),
      },
      authorisation: {
        saId: `SA-${row.id.slice(0, SHORT_ID_LENGTH).toUpperCase()}`,
        signedBy: row.approver_name,
        keyId: 'bw-demo-key',
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

  async run(runId: string, afterSeq: number): Promise<Record<string, unknown>> {
    const row = await this.runRow(runId);
    const [events, findings, gate2, stats] = await Promise.all([
      this.store.listEvents(runId, afterSeq),
      this.store.listFindingsForRun(this.tenantId, runId),
      this.store.listGate2ForRun(this.tenantId, runId),
      this.store.runStats(runId),
    ]);
    const now = new Date();
    return {
      ...runDto(row),
      lastSeq: events.at(-1)?.seq ?? afterSeq,
      events: events.map((e) => ({
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

  async setPaused(actor: DemoActor, runId: string, paused: boolean): Promise<Record<string, unknown>> {
    requireRole(actor, ['appsec-engineer', 'asset-owner'], 'Only an appsec engineer or an asset owner controls a run.');
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
  async kill(actor: DemoActor, runId: string, confirm: string): Promise<{ killRequestedAt: string }> {
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
      return { killRequestedAt: killedQueued.toISOString() };
    }
    const requestedAt = await this.store.requestKill(this.tenantId, runId, actor.id);
    if (requestedAt === null) {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'run_not_running', 'The run is not queued or running.');
    }
    await this.store.appendEvent(runId, {
      kind: 'kill.requested',
      stage: 'control',
      message: `Kill requested by ${actor.name}.`,
      data: { by: actor.id },
    });
    return { killRequestedAt: requestedAt.toISOString() };
  }

  async gate2(id: string): Promise<Record<string, unknown>> {
    const row = await this.gate2Row(id);
    const run = await this.runRow(row.run_id);
    return {
      ...gate2Dto(row, new Date()),
      run: { id: run.id, shortId: shortId(run.id), state: run.state, assetName: run.asset_name, pins: run.pins },
    };
  }

  private async gate2Row(id: string): Promise<Gate2Row> {
    const row = await this.store.getGate2(this.tenantId, id);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such Gate 2 request.');
    return row;
  }

  /** No decision before the deadline means denied: the worker treats a late or missing decision as a refusal. */
  async decideGate2(actor: DemoActor, id: string, decision: 'approve' | 'deny'): Promise<Record<string, unknown>> {
    requireRole(actor, ['asset-owner', 'appsec-engineer'], 'Only an asset owner or an appsec engineer decides Gate 2.');
    const row = await this.gate2Row(id);
    const run = await this.runRow(row.run_id);
    if (run.state === 'killed') {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'gate2_closed', 'The run was killed; nothing can be approved.');
    }
    const status = decision === 'approve' ? 'approved' : 'denied';
    if (!(await this.store.decideGate2(this.tenantId, id, status, actor.id))) {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'gate2_closed', 'The request is already decided or past its deadline.');
    }
    return this.gate2(id);
  }

  async finding(id: string): Promise<FindingRow> {
    const row = await this.store.getFinding(this.tenantId, id);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such finding.');
    return row;
  }

  /** Context the report needs: the finding, its run, asset and request. */
  async reportContext(findingId: string): Promise<{
    finding: FindingRow;
    run: RunRow;
    asset: AssetRow;
    request: RequestRow;
  }> {
    const finding = await this.finding(findingId);
    const run = await this.runRow(finding.run_id);
    const request = await this.store.getRequest(this.tenantId, run.request_id);
    const asset = await this.store.getAsset(this.tenantId, finding.asset_id);
    if (request === null || asset === null) {
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'The finding has no request or asset.');
    }
    return { finding, run, asset, request };
  }

  async listFindings(): Promise<Record<string, unknown>[]> {
    return (await this.store.listFindings(this.tenantId, FINDING_LIST_LIMIT)).map((row) => findingSummaryDto(row));
  }
}
