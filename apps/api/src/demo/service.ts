// DEMO-STORY business rules: assets and ownership proof, assessment requests, Gate 1 (separation of duties),
// run start and control (pause, kill), Gate 2 decisions and finding reads. The hunt itself runs in the worker.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { HttpException, HttpStatus, Logger } from '@nestjs/common';

import { owaspTop10Title } from '@blackwing/domain';
import { scrub, scrubDeep, scrubHeaders } from '@blackwing/errors/scrub';
import { newId } from '@blackwing/ids';

import { verifyChain, type AuditPayload, type AuditRef, type ChainState } from './audit.js';
import { BUDGET_LIMITS, BUDGET_PRESETS, DEFAULT_HUNT_CONCURRENCY, OBJECTIVE_MAX } from './config.js';
import { defaultLookup, firstRefusal, isLabOrigin, type Lookup, type OriginPolicy } from './ownership.js';
import {
  BODY_EXCERPT_CHARS,
  type AssetRow,
  type AuditEntry,
  type DemoStore,
  type EmergencyContact,
  type EmergencyLinkRow,
  type ExchangeRow,
  type FindingRow,
  type Gate2Row,
  type RequestRow,
  type RunEventRow,
  type RunRow,
} from './store.js';
import { InProcessRateLimiter } from '../rate-limit/limiter.js';

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
/** Gate 3 release mode of a request: `hold` waits for a human, `auto` releases what the validator proves. */
export const RELEASE_MODES = ['hold', 'auto'] as const;
type ReleaseMode = (typeof RELEASE_MODES)[number];
const DEFAULT_GATE2_TIMEOUT_S = 300;

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

/** The run id as people type and read it (kill confirmation, breadcrumbs). UUIDv7 ids start with their timestamp,
 *  so ids made in the same minute share a prefix: the random tail tells them apart (the web uses the same rule). */
export const shortId = (id: string): string => id.replace(/-/g, '').slice(-SHORT_ID_LENGTH).toUpperCase();

export type KillScope = 'target' | 'workspace';

export interface StoppedRun {
  readonly id: string;
  readonly assetId: string;
  readonly assetName: string;
  readonly killRequestedAt: string;
}

/** What the person types to stop a whole workspace: its name, or STOP ALL while it has none. */
export const workspaceConfirm = (name: string | null | undefined): string =>
  name === null || name === undefined || name.trim() === '' ? 'STOP ALL' : name.trim();

/** Typed confirmations compare without case and with runs of spaces folded. */
export const confirmMatches = (typed: string, expected: string): boolean => {
  const fold = (v: string): string => v.trim().replace(/\s+/g, ' ').toLowerCase();
  return fold(typed) !== '' && fold(typed) === fold(expected);
};

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

/** Requests created before release modes existed behaved as `auto`; their DTO, pins and clones say so. */
const releaseModeOf = (row: RequestRow): ReleaseMode => row.scope.releaseProven ?? 'auto';

/** True when every origin of the asset is an operator-listed lab (owner attestation is allowed only then). */
export const assetIsLab = (row: AssetRow, policy: OriginPolicy): boolean =>
  row.allowed_origins.length > 0 && row.allowed_origins.every((o) => isLabOrigin(o, policy));

export function assetDto(row: AssetRow, policy: OriginPolicy = NO_LAB_POLICY): Record<string, unknown> {
  const lab = assetIsLab(row, policy);
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
      methods: lab ? ['http_token', 'owner_attestation'] : ['http_token'],
    },
    lab,
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
    releaseProven: releaseModeOf(row),
    intrusiveness: row.intrusiveness,
    budget: {
      requests: row.budget_requests,
      seconds: row.budget_seconds,
      costUsd: Number(row.cost_cap_usd),
    },
    status: row.status,
    version: row.version,
    requester: { id: row.requester_id, name: row.requester_name },
    approver: row.approver_id === null ? null : { id: row.approver_id, name: row.approver_name },
    testAccounts: row.test_accounts.map((a) => ({ role: a.role, headerName: a.header_name })),
    decisionReason: row.decision_reason,
    decidedAt: iso(row.decided_at),
    createdAt: row.created_at.toISOString(),
    runId: null,
  };
}

/** The OWASP Top 10 label in its canonical form (`A03:2021 Injection`); unknown text is shown as stored. */
export function owaspLabel(stored: string): string {
  const match = /\bA\s*0?(10|[1-9])\b/i.exec(stored);
  if (match === null) return stored;
  const code = match[1] === '10' ? 'A10' : `A0${match[1] ?? ''}`;
  const title = owaspTop10Title(code);
  return title === null ? stored : `${code}:2021 ${title}`;
}

/** Target data and model text of a finding with secrets replaced (rows stored before store-time scrubbing too). */
export function scrubFinding(row: FindingRow): FindingRow {
  return {
    ...row,
    title: scrub(row.title),
    description: row.description === null ? null : scrub(row.description),
    repro_curl: scrub(row.repro_curl),
    evidence: scrubDeep(row.evidence),
    replay: scrubDeep(row.replay),
    oracle: scrubDeep(row.oracle),
    location: scrubDeep(row.location),
  };
}

export function runDto(row: RunRow, concurrency: number = DEFAULT_HUNT_CONCURRENCY): Record<string, unknown> {
  const ahead = row.state === 'queued' ? row.queue_ahead : null;
  return {
    id: row.id,
    shortId: shortId(row.id),
    requestId: row.request_id,
    assetId: row.asset_id,
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
    summary: row.summary === null ? null : scrub(row.summary),
    pins: scrubDeep(row.pins),
    startedBy: row.started_by_name === null ? null : { id: row.created_by, name: row.started_by_name },
    queue:
      ahead === null
        ? null
        : { position: ahead + 1, ahead, running: row.queue_running ?? 0, concurrency },
  };
}

/** The fields a list needs; the full evidence is in {@link findingDto}. */
export function findingSummaryDto(row: FindingRow): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    assetId: row.asset_id,
    assetName: row.asset_name,
    title: scrub(row.title),
    status: row.status,
    severity: severityOf(row.severity),
    cwe: row.cwe_id,
    owasp: owaspLabel(row.owasp_category),
    agent: row.agent,
    createdAt: row.created_at.toISOString(),
    identityKey: row.identity_key,
    seenBefore:
      row.seen_run_id === null || row.seen_finding_id === null || row.seen_status === null || row.seen_at === null
        ? null
        : { runId: row.seen_run_id, findingId: row.seen_finding_id, status: row.seen_status, at: row.seen_at.toISOString() },
  };
}

export function findingDto(
  row: FindingRow,
  audit: AuditRef | null = null,
): Record<string, unknown> {
  const clean = scrubFinding(row);
  return {
    ...findingSummaryDto(clean),
    class: row.class,
    confidence: Number(row.confidence),
    description: clean.description,
    oracle: clean.oracle,
    evidence: clean.evidence,
    replay: clean.replay,
    reproCurl: clean.repro_curl,
    testCaseId: row.test_case_id,
    location: clean.location,
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

/** Scrubbed first, then cut: a secret cut in half would no longer match the scrub patterns. */
const excerpt = (body: string): string => scrub(body).slice(0, BODY_EXCERPT_CHARS);

export function exchangeDto(row: ExchangeRow): Record<string, unknown> {
  return {
    id: row.id,
    seq: row.seq,
    agent: row.agent,
    method: row.method,
    url: scrub(row.url),
    requestHeaders: scrubHeaders(row.request_headers),
    requestBody: row.request_body === null ? null : excerpt(row.request_body),
    status: row.status,
    responseHeaders: row.response_headers === null ? null : scrubHeaders(row.response_headers),
    responseBody: row.response_body === null ? null : excerpt(row.response_body),
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
    url: scrub(row.url),
    pathKey: row.path_key,
    intrusiveness: row.intrusiveness,
    reason: row.reason === null ? null : scrub(row.reason),
    whyOutside: row.why_outside,
    status: row.status,
    deadlineAt: row.deadline_at.toISOString(),
    secondsLeft: row.status === 'pending' ? secondsLeft(row.deadline_at, now) : 0,
    decidedBy: row.decided_by_name,
    decisionReason: row.decision_reason,
    decidedAt: iso(row.decided_at),
    createdAt: row.created_at.toISOString(),
    body: row.request_body === null ? null : scrub(row.request_body),
    asRole: row.as_role,
    assetName: row.asset_name,
    requester:
      row.requester_id === null ? null : { id: row.requester_id, name: row.requester_name ?? 'Unknown' },
    runStartedAt: iso(row.run_started_at),
    closeReason: row.close_reason,
  };
}

/** A run event as the console reads it: message and data scrubbed (the agent's own words can quote a secret). */
const eventDto = (e: RunEventRow): Record<string, unknown> => ({
  seq: e.seq,
  kind: e.kind,
  stage: e.stage,
  message: scrub(e.message),
  data: scrubDeep(e.data),
  at: e.at.toISOString(),
});

/** How the run ended: the reason of its last end event (`killed` for a kill), or null while it runs. */
export function endReasonOf(events: readonly RunEventRow[]): string | null {
  const last = events
    .filter((e) => (END_EVENT_KINDS as readonly string[]).includes(e.kind))
    .sort((a, b) => b.seq - a.seq)[0];
  if (last === undefined) return null;
  if (last.kind === 'run.killed') return 'killed';
  const reason = last.data.reason;
  if (typeof reason === 'string') return reason;
  return last.kind === 'run.failed' ? 'failed' : null;
}

const coverageOf = (events: readonly RunEventRow[]): Record<string, unknown> | null => {
  const event = events.find((e) => e.kind === COVERAGE_KIND);
  return event === undefined ? null : scrubDeep(event.data);
};

export interface CreateAssetInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly extraOrigins: readonly string[];
  readonly excludedPaths: readonly string[];
}

export interface VerifyInput {
  readonly method: 'http_token' | 'owner_attestation';
  readonly statement?: string | undefined;
}

/** A plan edit (PATCH /requests/:id): every field optional; an account without a value keeps the stored one. */
export interface AmendRequestInput {
  readonly version: number;
  readonly objective?: string | undefined;
  readonly intrusiveness?: (typeof INTRUSIVENESS)[number] | undefined;
  readonly budgetRequests?: number | undefined;
  readonly budgetSeconds?: number | undefined;
  readonly costCapUsd?: number | undefined;
  readonly excludedPaths?: readonly string[] | undefined;
  readonly releaseProven?: ReleaseMode | undefined;
  readonly testAccounts?:
    | readonly { role: string; headerName: string; headerValue?: string | undefined }[]
    | undefined;
}

export interface TriageResult {
  readonly id: string;
  readonly ok: boolean;
  readonly status?: string;
  readonly code?: 'finding_not_triageable' | 'not_found';
}

export interface CreateRequestInput {
  readonly assetId: string;
  readonly objective: string;
  readonly intrusiveness: (typeof INTRUSIVENESS)[number];
  readonly budgetRequests: number;
  readonly budgetSeconds: number;
  readonly costCapUsd: number;
  readonly excludedPaths: readonly string[];
  readonly releaseProven: ReleaseMode;
  readonly testAccounts: readonly { role: string; headerName: string; headerValue: string }[];
}

export interface WebhookOptions {
  readonly webhookUrl: string | null;
  readonly consoleOrigin: string;
}

export interface WorkspaceOptions {
  /** BW_GATE2_TIMEOUT_S, the deadline the worker gives each Gate 2 request. */
  readonly gate2TimeoutS: number;
  /** BW_HUNT_CONCURRENCY: runs the hunt engine runs at once (queue positions). */
  readonly huntConcurrency?: number;
  /** Lab allow-list and Blackwing's own origins; without it every private address is refused. */
  readonly origins?: OriginPolicy;
  readonly lookup?: Lookup;
}

/** Ownership proof: the well-known file the site serves. */
const ATTESTATION_STATEMENT_MAX = 1000;
const NO_LAB_POLICY: OriginPolicy = { labOrigins: [], platformOrigins: [], platformPorts: [] };
/** Kinds whose last event describes how a run ended and what it covered. */
const END_EVENT_KINDS = ['run.completed', 'run.failed', 'run.killed'] as const;
const COVERAGE_KIND = 'coverage.summary';
const RETESTS_SHOWN = 5;
/** A probe the runner may replay on its own (no Gate 2): methods that do not change state. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

const entryOf = (
  actor: DemoActor,
  action: string,
  targetType: string,
  targetId: string,
  payload: AuditPayload,
): AuditEntry => ({ actorId: actor.id, actorName: actor.name, action, targetType, targetId, payload });

/** How long an emergency stop link works, in seconds. */
export const EMERGENCY_VALIDITY_S = { '1h': 3600, '24h': 86_400, '7d': 604_800 } as const;
export type EmergencyValidity = keyof typeof EMERGENCY_VALIDITY_S;
export const EMERGENCY_VALIDITIES = Object.keys(EMERGENCY_VALIDITY_S) as [EmergencyValidity, ...EmergencyValidity[]];
const EMERGENCY_TOKEN_BYTES = 32;
/** 32 bytes in base64url, unpadded. */
export const EMERGENCY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Per client: 30 attempts at once, then one a second. The token has 256 bits; this only slows a scan. */
const EMERGENCY_RATE = { rps: 1, burst: 30 } as const;

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

const emergencyExpired = (): DemoRefusal =>
  new DemoRefusal(HttpStatus.NOT_FOUND, 'emergency_link_expired', 'This emergency link has expired.');

export const emergencyLinkDto = (row: EmergencyLinkRow): Record<string, unknown> => ({
  id: row.id,
  label: row.label,
  createdBy: { id: row.created_by, name: row.created_by_name },
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  lastUsedAt: iso(row.last_used_at),
});

/** A run as the no-login emergency page sees it: the target's name and the halt, nothing more. */
const emergencyRunDto = (row: RunRow): Record<string, unknown> => ({
  id: row.id,
  shortId: shortId(row.id),
  assetName: row.asset_name,
  state: row.state,
  haltMs: row.halt_ms,
});

const planChanged = (): DemoRefusal =>
  new DemoRefusal(HttpStatus.CONFLICT, 'plan_changed', 'The plan changed in another tab. Reload to see it.');

export class DemoService {
  private readonly logger = new Logger('DemoService');
  private readonly emergencyLimiter = new InProcessRateLimiter();

  constructor(
    private readonly store: DemoStore,
    private readonly tenantId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly webhook: WebhookOptions = {
      webhookUrl: null,
      consoleOrigin: 'http://localhost:3000',
    },
    private readonly options: WorkspaceOptions = { gate2TimeoutS: DEFAULT_GATE2_TIMEOUT_S },
  ) {}

  private get origins(): OriginPolicy {
    return this.options.origins ?? NO_LAB_POLICY;
  }

  private get concurrency(): number {
    return this.options.huntConcurrency ?? DEFAULT_HUNT_CONCURRENCY;
  }

  private runView(row: RunRow): Record<string, unknown> {
    return runDto(row, this.concurrency);
  }

  /** The workspace and the settings the console needs. `name` is null until the first admin names it (/welcome). */
  async workspace(actor: DemoActor): Promise<Record<string, unknown>> {
    const tenant = await this.store.getTenant(this.tenantId);
    if (tenant === null)
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'workspace_not_found', 'The workspace does not exist.');
    const { webhookUrl } = this.webhook;
    return {
      id: tenant.id,
      name: tenant.name === '' ? null : tenant.name,
      settings: {
        gate2TimeoutS: this.options.gate2TimeoutS,
        huntConcurrency: this.concurrency,
        selfApprove: actor.admin === true,
        limits: BUDGET_LIMITS,
        presets: BUDGET_PRESETS,
        // The host only: the webhook URL itself can carry a secret token.
        webhook: { configured: webhookUrl !== null, host: webhookUrl === null ? null : new URL(webhookUrl).host },
        emergencyContact: await this.store.getEmergencyContact(this.tenantId),
      },
    };
  }

  /** Names (or renames) the workspace. Administrators only; recorded in the ledger. */
  async renameWorkspace(actor: DemoActor, name: string): Promise<Record<string, unknown>> {
    if (actor.admin !== true)
      throw new DemoRefusal(HttpStatus.FORBIDDEN, 'admin_required', 'Only an administrator can name the workspace.');
    if (!(await this.store.renameTenant(this.tenantId, name)))
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'workspace_not_found', 'The workspace does not exist.');
    await this.audit(actor, 'workspace.named', 'tenant', this.tenantId, { name });
    return this.workspace(actor);
  }

  private audit(
    actor: DemoActor,
    action: string,
    targetType: string,
    targetId: string,
    payload: AuditPayload,
  ): Promise<AuditRef> {
    return this.store.appendAudit(this.tenantId, entryOf(actor, action, targetType, targetId, payload));
  }

  async assets(): Promise<Record<string, unknown>[]> {
    return (await this.store.listAssets(this.tenantId)).map((row) => assetDto(row, this.origins));
  }

  async asset(id: string): Promise<Record<string, unknown>> {
    return assetDto(await this.assetRow(id), this.origins);
  }

  /** Plain-words refusal when any of `origins` may not be tested (deny-list, lab allow-list), else null. */
  private targetRefusal(origins: readonly string[]): Promise<string | null> {
    return firstRefusal(origins, this.origins, this.options.lookup ?? defaultLookup);
  }

  /**
   * Ownership must still hold when Gate 1 approves and when the run starts: the deny rules again, then the proof
   * itself (the well-known file is fetched again; an attestation needs the site to still be a listed lab). On
   * failure the asset goes back to unverified, the ledger records why, and the caller is refused.
   */
  private async recheckOwnership(actor: DemoActor, asset: AssetRow, at: 'gate1' | 'run_start' | 'retest'): Promise<void> {
    const reason = (await this.targetRefusal(asset.allowed_origins)) ?? (await this.proofProblem(asset));
    if (reason === null) return;
    const origin = new URL(asset.base_url).origin;
    const cause = reason.replace(/\.$/, '');
    if (await this.store.markAssetUnverified(this.tenantId, asset.id)) {
      await this.audit(actor, 'asset.unverified', 'asset', asset.id, { origin, reason: cause, at });
    }
    throw new DemoRefusal(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'ownership_recheck_failed',
      `Blackwing checked ownership of ${origin} again and it no longer holds: ${cause}. Prove ownership again to go ahead.`,
    );
  }

  private async assetRow(id: string): Promise<AssetRow> {
    const row = await this.store.getAsset(this.tenantId, id);
    if (row === null)
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'asset_not_found', 'No such asset.');
    return row;
  }

  async createAsset(actor: DemoActor, input: CreateAssetInput): Promise<Record<string, unknown>> {
    requireRole(actor, ['appsec-engineer'], 'Only an appsec engineer can register an asset.');
    const origins = originsOf([input.baseUrl, ...input.extraOrigins]);
    const refusal = await this.targetRefusal(origins);
    if (refusal !== null) throw new DemoRefusal(HttpStatus.UNPROCESSABLE_ENTITY, 'target_not_allowed', refusal);
    const origin = new URL(input.baseUrl).origin;
    const existing = (await this.store.listAssets(this.tenantId)).find(
      (a) => new URL(a.base_url).origin === origin,
    );
    if (existing !== undefined) return assetDto(existing, this.origins);
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
      allowed_origins: origins,
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
    const refusal = await this.targetRefusal(asset.allowed_origins);
    if (refusal !== null) throw new DemoRefusal(HttpStatus.UNPROCESSABLE_ENTITY, 'target_not_allowed', refusal);
    const lab = assetIsLab(asset, this.origins);
    if (input.method === 'owner_attestation' && !lab) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'attestation_not_allowed',
        'This site is not a listed lab, so ownership must be proved with the verification file.',
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
    await this.audit(actor, 'asset.verified', 'asset', id, {
      method: input.method,
      origin: new URL(asset.base_url).origin,
      tokenPath: input.method === 'http_token' ? WELL_KNOWN_PATH : null,
      statement:
        input.method === 'owner_attestation' ? (input.statement ?? '').slice(0, ATTESTATION_STATEMENT_MAX) : null,
      lab,
    });
    return this.asset(id);
  }

  /** Why the recorded ownership proof no longer holds, in plain words, or null when it does. */
  private async proofProblem(asset: AssetRow): Promise<string | null> {
    if (asset.verification_method === 'http_token') return this.wellKnownProblem(asset);
    return assetIsLab(asset, this.origins)
      ? null
      : 'an owner attestation covers listed labs only, and this site is not one';
  }

  /** What is wrong with the well-known proof of `asset`, in plain words, or null when it holds. */
  private async wellKnownProblem(asset: AssetRow): Promise<string | null> {
    const url = `${new URL(asset.base_url).origin}${WELL_KNOWN_PATH}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
    } catch {
      return 'the site did not answer';
    }
    if (!response.ok) return `the file is gone (the site answered ${response.status})`;
    const body = await response.text().catch(() => '');
    return asset.verification_token !== null && body.includes(asset.verification_token)
      ? null
      : 'the file does not hold the verification token';
  }

  private async checkWellKnownToken(asset: AssetRow): Promise<void> {
    const problem = await this.wellKnownProblem(asset);
    if (problem !== null) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'verification_failed',
        `${new URL(asset.base_url).origin}${WELL_KNOWN_PATH} did not answer 200 with the verification token: ${problem}.`,
      );
    }
  }

  async dashboard(actor: DemoActor): Promise<Record<string, unknown>> {
    const analyst = actorHasRole(actor, 'appsec-engineer');
    const [tenant, counts, assets, requests, runs, findings, pending, pendingCounts, live] = await Promise.all([
      this.store.getTenant(this.tenantId),
      this.store.dashboardCounts(this.tenantId),
      this.store.listAssets(this.tenantId),
      this.store.listPendingGate1(this.tenantId),
      this.store.listRuns(this.tenantId, RECENT_ITEMS),
      this.store.listFindings(this.tenantId, RECENT_ITEMS, analyst),
      this.store.listPendingGate2(this.tenantId),
      this.store.pendingCounts(this.tenantId, analyst),
      this.store.listLiveRuns(this.tenantId),
    ]);
    const now = new Date();
    return {
      tenant: { id: this.tenantId, name: tenant === null || tenant.name === '' ? null : tenant.name },
      actor: { id: actor.id, name: actor.name, roles: actor.roles },
      counts: { ...counts, gate2Pending: pending.length },
      assets: assets.slice(0, RECENT_ITEMS).map((row) => assetDto(row, this.origins)),
      requests: requests.map((row) => requestDto(row)),
      runs: runs.map((row) => this.runView(row)),
      findings: findings.map((row) => findingSummaryDto(row)),
      pendingGate2: pending.map((row) => gate2Dto(row, now)),
      pendingCounts,
      liveRuns: live.map((row) => this.runView(row)),
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
      scope: { excludedPaths: [...input.excludedPaths], releaseProven: input.releaseProven },
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

  /**
   * Retest: a new pending request with the same answers. The test-account values are copied server-side. With
   * `untriedFromRunId`, the test cases that run left untried are appended to the objective.
   */
  async cloneRequest(actor: DemoActor, id: string, untriedFromRunId?: string): Promise<Record<string, unknown>> {
    const row = await this.store.getRequest(this.tenantId, id);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such request.');
    const objective =
      untriedFromRunId === undefined ? row.objective : await this.untriedObjective(row, untriedFromRunId);
    return this.createRequest(actor, {
      assetId: row.asset_id,
      objective,
      intrusiveness: row.intrusiveness === 'passive' ? 'passive' : 'active_safe',
      budgetRequests: row.budget_requests,
      budgetSeconds: row.budget_seconds,
      costCapUsd: Number(row.cost_cap_usd),
      excludedPaths: row.scope.excludedPaths ?? [],
      releaseProven: releaseModeOf(row),
      testAccounts: row.test_accounts.map((a) => ({
        role: a.role,
        headerName: a.header_name,
        headerValue: a.header_value,
      })),
    });
  }

  /** The objective plus the run's untried test cases (from its `coverage.summary`), clipped to the limit. */
  private async untriedObjective(row: RequestRow, runId: string): Promise<string> {
    const run = await this.store.getRun(this.tenantId, runId);
    if (run?.request_id !== row.id) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such run.');
    const cases = coverageOf(await this.store.lastEvents(runId, [COVERAGE_KIND]))?.cases;
    const titles = (Array.isArray(cases) ? cases : [])
      .filter((c): c is { status: string; title: string } => {
        const value = c as { status?: unknown; title?: unknown } | null;
        return value?.status === 'not_run' && typeof value.title === 'string';
      })
      .map((c) => c.title);
    if (titles.length === 0) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'nothing_untried',
        'That audit left no test case untried.',
      );
    }
    const text = `${row.objective}\n\nContinue with the test cases left untried in audit ${shortId(run.id)}: ${titles.join('; ')}`;
    return text.slice(0, OBJECTIVE_MAX);
  }

  /** Edits a pending plan in place (no clone, no reject). Only the requester or an administrator. */
  async amendRequest(actor: DemoActor, id: string, input: AmendRequestInput): Promise<Record<string, unknown>> {
    requireRole(actor, ['appsec-engineer'], 'Only an appsec engineer can edit a plan.');
    const row = await this.store.getRequest(this.tenantId, id);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such request.');
    if (row.requester_id !== actor.id && actor.admin !== true) {
      throw new DemoRefusal(HttpStatus.FORBIDDEN, 'not_requester', 'Only the person who asked for this audit can edit its plan.');
    }
    if (row.status !== 'pending_gate1') {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'request_not_pending', `The request is ${row.status}; its plan can no longer change.`);
    }
    if (input.version !== row.version) throw planChanged();
    const asset = await this.assetRow(row.asset_id);
    if (asset.ownership_status !== 'verified') {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'asset_not_verified',
        'Ownership must be verified before an assessment can be requested.',
      );
    }
    const accounts =
      input.testAccounts === undefined
        ? row.test_accounts.map((a) => ({ ...a }))
        : input.testAccounts.map((a) => {
            if (a.headerValue !== undefined) return { role: a.role, header_name: a.headerName, header_value: a.headerValue };
            const stored = row.test_accounts.find(
              (s) =>
                s.role.toLowerCase() === a.role.toLowerCase() &&
                s.header_name.toLowerCase() === a.headerName.toLowerCase(),
            );
            if (stored === undefined) {
              throw new DemoRefusal(
                HttpStatus.UNPROCESSABLE_ENTITY,
                'account_value_missing',
                `Type the ${a.headerName} value for the test account "${a.role}": no value is saved for it.`,
              );
            }
            return { role: a.role, header_name: a.headerName, header_value: stored.header_value };
          });
    const next = {
      objective: input.objective ?? row.objective,
      intrusiveness: input.intrusiveness ?? row.intrusiveness,
      budget_requests: input.budgetRequests ?? row.budget_requests,
      budget_seconds: input.budgetSeconds ?? row.budget_seconds,
      cost_cap_usd: input.costCapUsd ?? Number(row.cost_cap_usd),
      excludedPaths: input.excludedPaths === undefined ? (row.scope.excludedPaths ?? []) : [...input.excludedPaths],
      releaseProven: input.releaseProven ?? releaseModeOf(row),
    };
    const before = {
      objective: row.objective,
      intrusiveness: row.intrusiveness,
      budget: [row.budget_requests, row.budget_seconds, Number(row.cost_cap_usd)],
      excludedPaths: row.scope.excludedPaths ?? [],
      releaseProven: releaseModeOf(row),
      testAccounts: row.test_accounts.map((a) => [a.role, a.header_name, a.header_value]),
    };
    const after = {
      objective: next.objective,
      intrusiveness: next.intrusiveness,
      budget: [next.budget_requests, next.budget_seconds, next.cost_cap_usd],
      excludedPaths: next.excludedPaths,
      releaseProven: next.releaseProven,
      testAccounts: accounts.map((a) => [a.role, a.header_name, a.header_value]),
    };
    const changed = (Object.keys(before) as (keyof typeof before)[]).filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
    if (changed.length === 0) return this.request(id, actor);
    const version = await this.store.amendRequest(this.tenantId, id, row.version, {
      objective: next.objective,
      scope: { ...row.scope, excludedPaths: next.excludedPaths, releaseProven: next.releaseProven },
      intrusiveness: next.intrusiveness,
      budget_requests: next.budget_requests,
      budget_seconds: next.budget_seconds,
      cost_cap_usd: next.cost_cap_usd,
      test_accounts: accounts,
    });
    if (version === null) throw await this.lostDecisionRace(id, planChanged());
    const audit = await this.audit(actor, 'gate1.amend', 'request', id, {
      version,
      changed: changed.join(','),
      objective: next.objective,
      excludedPaths: next.excludedPaths.join(','),
      intrusiveness: next.intrusiveness,
      budget: `${next.budget_requests} requests, ${next.budget_seconds} s, $${next.cost_cap_usd.toFixed(2)}`,
      accounts: accounts.map((a) => a.role).join(','),
    });
    return this.request(id, actor, audit);
  }

  /** After a conditional update moved nothing: `request_not_pending` when it was decided, else `fallback`. */
  private async lostDecisionRace(id: string, fallback: DemoRefusal): Promise<DemoRefusal> {
    const now = await this.store.getRequest(this.tenantId, id);
    return now?.status === 'pending_gate1'
      ? fallback
      : new DemoRefusal(HttpStatus.CONFLICT, 'request_not_pending', `The request is ${now?.status ?? 'gone'}; Gate 1 is already decided.`);
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
    version: number | null = null,
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
    if (version !== null && version !== row.version) throw planChanged();
    if (decision === 'approve') await this.recheckOwnership(actor, await this.assetRow(row.asset_id), 'gate1');
    const ok = await this.store.decideRequest(
      this.tenantId,
      requestId,
      actor.id,
      decision === 'approve' ? 'approved' : 'rejected',
      reason,
      row.version,
    );
    if (!ok) throw await this.lostDecisionRace(requestId, planChanged());
    const audit = await this.audit(actor, `gate1.${decision}`, 'request', requestId, {
      decision,
      reason,
      selfApproved,
      override: selfApproved ? 'admin' : null,
      version: row.version,
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
    if ((await this.store.findRunByRequest(this.tenantId, requestId)) !== null) {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'run_already_started', 'This request already has a run.');
    }
    const asset = await this.assetRow(row.asset_id);
    if (asset.ownership_status !== 'verified') {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'asset_not_verified',
        'Asset ownership is not verified.',
      );
    }
    await this.recheckOwnership(actor, asset, 'run_start');
    if (!(await this.store.claimRequestForRun(this.tenantId, requestId))) {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'run_already_started',
        'This request already has a run.',
      );
    }
    const runId = newId();
    const labOrigins = asset.allowed_origins.filter((o) => isLabOrigin(o, this.origins));
    const pins = {
      asset: {
        id: asset.id,
        name: asset.name,
        baseUrl: asset.base_url,
        allowedOrigins: asset.allowed_origins,
        labOrigins,
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
        releaseProven: releaseModeOf(row),
        requesterId: row.requester_id,
        approverId: row.approver_id,
        decidedAt: iso(row.decided_at),
      },
      authorisation: {
        saId: `SA-${row.id.slice(0, SHORT_ID_LENGTH).toUpperCase()}`,
        signedBy: row.approver_name,
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
    const approval = await this.store.latestAudit(this.tenantId, 'request', requestId, 'gate1.approve');
    await this.audit(actor, 'run.started', 'run', runId, {
      requestId,
      approvalEventId: approval?.eventId ?? null,
      version: row.version,
      labOrigins: labOrigins.join(','),
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
    const [events, findings, gate2, stats, coverage] = await Promise.all([
      this.store.listEvents(runId, afterSeq),
      this.store.listFindingsForRun(this.tenantId, runId, analyst),
      this.store.listGate2ForRun(this.tenantId, runId),
      this.store.runStats(runId),
      this.store.lastEvents(runId, [COVERAGE_KIND]),
    ]);
    const now = new Date();
    return {
      ...this.runView(row),
      lastSeq: events.at(-1)?.seq ?? afterSeq,
      // Suspected findings are for analysts only, so their events are too.
      events: events.filter((e) => analyst || e.kind !== 'finding.suspected').map((e) => eventDto(e)),
      findings: findings.map((f) => findingSummaryDto(f)),
      gate2: gate2.map((g) => gate2Dto(g, now)),
      stats,
      coverage: coverageOf(coverage),
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
    const run = await this.runRow(runId);
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
    await this.audit(actor, paused ? 'run.pause' : 'run.resume', 'run', runId, { requestId: run.request_id });
    return this.runView(await this.runRow(runId));
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
    const halted = await this.haltRun(runId, actor);
    if (halted === null) {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'run_not_running',
        'The run is not queued or running.',
      );
    }
    const audit = await this.audit(actor, 'run.kill', 'run', runId, { confirm, queued: halted.queued });
    return { killRequestedAt: halted.at.toISOString(), audit };
  }

  /**
   * Stops one run (the caller writes the ledger): a queued run is killed here, a running or paused one is flagged and
   * the worker halts it. Null when the run is no longer live. `by.id` is null for an emergency link (no login).
   */
  private async haltRun(
    runId: string,
    by: { readonly id: string | null; readonly name: string },
  ): Promise<{ at: Date; queued: boolean } | null> {
    const killedQueued = await this.store.killQueuedRun(this.tenantId, runId, by.id);
    if (killedQueued !== null) {
      await this.store.appendEvent(runId, {
        kind: 'run.killed',
        stage: 'control',
        message: `Run killed by ${by.name} before it started.`,
        data: { by: by.id, haltMs: 0 },
      });
      return { at: killedQueued, queued: true };
    }
    const requestedAt = await this.store.requestKill(this.tenantId, runId, by.id);
    if (requestedAt === null) return null;
    await this.store.appendEvent(runId, {
      kind: 'kill.requested',
      stage: 'control',
      message: `Kill requested by ${by.name}.`,
      data: { by: by.id },
    });
    return { at: requestedAt, queued: false };
  }

  /**
   * Stop every live run in a blast radius: `target` (every run on one asset) or `workspace` (every run of the tenant).
   * The person types the target's or the workspace's name. Each run goes through the per-run kill path; the ledger
   * gets one `run.kill` per run and then one `kill.scope` entry naming them all.
   */
  async killScope(
    actor: DemoActor,
    input: { readonly scope: 'target'; readonly assetId: string; readonly confirm: string } | { readonly scope: 'workspace'; readonly confirm: string },
  ): Promise<{ scope: KillScope; killRequestedAt: string; runs: StoppedRun[]; audit: AuditRef }> {
    const live = await this.store.listLiveRuns(this.tenantId);
    let runs: RunRow[];
    let expected: string;
    let target: { type: string; id: string };
    if (input.scope === 'target') {
      const asset = await this.assetRow(input.assetId);
      runs = live.filter((r) => r.asset_id === asset.id);
      expected = asset.name;
      target = { type: 'asset', id: asset.id };
    } else {
      runs = live;
      expected = workspaceConfirm((await this.store.getTenant(this.tenantId))?.name);
      target = { type: 'tenant', id: this.tenantId };
    }
    if (!confirmMatches(input.confirm, expected)) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'kill_confirmation_mismatch',
        `Type ${expected} to confirm.`,
      );
    }
    // Flag every run first, all at once: the halt clock starts for each before any bookkeeping.
    const halted = await Promise.all(runs.map(async (run) => ({ run, halt: await this.haltRun(run.id, actor) })));
    const stopped = halted.flatMap(({ run, halt }) => (halt === null ? [] : [{ run, halt }]));
    if (stopped.length === 0) {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'run_not_running', 'Nothing in that scope is queued or running.');
    }
    const refs = await this.store.appendAudits(this.tenantId, [
      ...stopped.map(({ run, halt }) =>
        entryOf(actor, 'run.kill', 'run', run.id, { scope: input.scope, queued: halt.queued }),
      ),
      entryOf(actor, 'kill.scope', target.type, target.id, {
        scope: input.scope,
        confirm: input.confirm,
        runs: stopped.length,
        runIds: stopped.map(({ run }) => run.id).join(','),
      }),
    ]);
    const audit = refs.at(-1);
    if (audit === undefined) throw new Error('audit append returned nothing');
    const first = Math.min(...stopped.map(({ halt }) => halt.at.getTime()));
    return {
      scope: input.scope,
      killRequestedAt: new Date(first).toISOString(),
      runs: stopped.map(({ run, halt }) => ({
        id: run.id,
        assetId: run.asset_id,
        assetName: run.asset_name,
        killRequestedAt: halt.at.toISOString(),
      })),
      audit,
    };
  }

  private requireAdmin(actor: DemoActor, detail: string): void {
    if (actor.admin !== true) throw new DemoRefusal(HttpStatus.FORBIDDEN, 'admin_required', detail);
  }

  /** The emergency stop links that still work (administrators only). */
  async emergencyLinks(actor: DemoActor): Promise<{ items: Record<string, unknown>[] }> {
    this.requireAdmin(actor, 'Only an administrator can see emergency stop links.');
    return { items: (await this.store.listActiveEmergencyLinks(this.tenantId)).map((row) => emergencyLinkDto(row)) };
  }

  /**
   * Creates an emergency stop link. The token (32 random bytes) is returned once and never stored: only its SHA-256
   * is kept. Recorded in the ledger without the token.
   */
  async createEmergencyLink(
    actor: DemoActor,
    validity: EmergencyValidity,
    label: string | null,
  ): Promise<{ link: Record<string, unknown>; token: string; audit: AuditRef }> {
    this.requireAdmin(actor, 'Only an administrator can create an emergency stop link.');
    const token = randomBytes(EMERGENCY_TOKEN_BYTES).toString('base64url');
    const row = await this.store.insertEmergencyLink({
      id: newId(),
      tenant_id: this.tenantId,
      token_hash: sha256(token),
      label,
      created_by: actor.id,
      created_by_name: actor.name,
      expires_at: new Date(Date.now() + EMERGENCY_VALIDITY_S[validity] * MS_PER_SECOND),
    });
    const audit = await this.audit(actor, 'emergency_link.created', 'emergency_link', row.id, {
      label,
      validity,
      expiresAt: row.expires_at.toISOString(),
    });
    return { link: emergencyLinkDto(row), token, audit };
  }

  async revokeEmergencyLink(actor: DemoActor, id: string): Promise<{ audit: AuditRef }> {
    this.requireAdmin(actor, 'Only an administrator can revoke an emergency stop link.');
    const row = await this.store.revokeEmergencyLink(this.tenantId, id, actor.id);
    if (row === null)
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'This link has already expired or been revoked.');
    const audit = await this.audit(actor, 'emergency_link.revoked', 'emergency_link', id, { label: row.label });
    return { audit };
  }

  /** Sets or clears the contact the expired-link page shows. Administrators only; recorded in the ledger. */
  async setEmergencyContact(actor: DemoActor, contact: EmergencyContact | null): Promise<Record<string, unknown>> {
    this.requireAdmin(actor, 'Only an administrator can set the emergency contact.');
    await this.store.setEmergencyContact(this.tenantId, contact);
    await this.audit(actor, 'workspace.emergency_contact', 'tenant', this.tenantId, {
      name: contact?.name ?? null,
    });
    return this.workspace(actor);
  }

  /**
   * The link behind a token when it still works; null for an unknown, expired or revoked token alike (nothing tells
   * them apart). Every attempt is charged to the client's bucket. The token is looked up by its hash, then the hashes
   * are compared in constant time.
   */
  private async liveEmergencyLink(token: string, client: string): Promise<EmergencyLinkRow | null> {
    const decision = await this.emergencyLimiter.consume([
      { key: `emergency:${client}`, scope: 'ip', ...EMERGENCY_RATE },
    ]);
    if (!decision.allowed)
      throw new DemoRefusal(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', 'Too many attempts. Wait a minute and try again.');
    if (!EMERGENCY_TOKEN.test(token)) return null;
    const hash = sha256(token);
    const row = await this.store.findEmergencyLink(this.tenantId, hash);
    if (row === null || !timingSafeEqual(row.token_hash, hash)) return null;
    return row.revoked_at === null && row.expires_at.getTime() > Date.now() ? row : null;
  }

  /** What the no-login emergency page shows. A dead link learns only the workspace's emergency contact, if one is set. */
  async emergencyView(token: string, client: string): Promise<Record<string, unknown>> {
    const link = await this.liveEmergencyLink(token, client);
    if (link === null) return { status: 'expired', contact: await this.store.getEmergencyContact(this.tenantId) };
    const tenant = await this.store.getTenant(this.tenantId);
    const live = await this.store.listLiveRuns(this.tenantId);
    return {
      status: 'active',
      workspace: tenant === null || tenant.name === '' ? null : tenant.name,
      liveRuns: live.length,
      link: { label: link.label, expiresAt: link.expires_at.toISOString() },
    };
  }

  /**
   * Stops every live run of the workspace through an emergency link: the same halt as Stop, one ledger entry for the
   * use and one `run.kill` per run, all in one append.
   */
  async emergencyStop(token: string, client: string): Promise<Record<string, unknown>> {
    const link = await this.liveEmergencyLink(token, client);
    if (link === null) throw emergencyExpired();
    const by = { id: null, name: link.label === null ? 'Emergency stop link' : `Emergency stop link (${link.label})` };
    const runs: Record<string, unknown>[] = [];
    for (const run of await this.store.listLiveRuns(this.tenantId)) {
      const halted = await this.haltRun(run.id, by);
      if (halted !== null) runs.push({ ...emergencyRunDto(run), queued: halted.queued });
    }
    await this.store.touchEmergencyLink(this.tenantId, link.id);
    const entry = (action: string, targetType: string, targetId: string, payload: AuditPayload): AuditEntry => ({
      actorId: null,
      actorName: by.name,
      action,
      targetType,
      targetId,
      payload,
    });
    const [audit] = await this.store.appendAudits(this.tenantId, [
      entry('emergency_link.used', 'emergency_link', link.id, { label: link.label, runs: runs.length }),
      ...runs.map((r) =>
        entry('run.kill', 'run', String(r.id), { via: 'emergency_link', linkId: link.id, queued: r.queued === true }),
      ),
    ]);
    return { stoppedAt: new Date().toISOString(), runs, audit };
  }

  /** The halt of the runs an emergency stop reached, while the link still works. */
  async emergencyRuns(token: string, client: string, ids: readonly string[]): Promise<Record<string, unknown>> {
    if ((await this.liveEmergencyLink(token, client)) === null) throw emergencyExpired();
    const rows = await Promise.all(ids.map((id) => this.store.getRun(this.tenantId, id)));
    return { runs: rows.flatMap((row) => (row === null ? [] : [emergencyRunDto(row)])) };
  }

  /** `audit` is the event just appended by a decision; a plain read looks up the latest one. */
  async gate2(id: string, viewer?: DemoActor, audit?: AuditRef): Promise<Record<string, unknown>> {
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
        pins: scrubDeep(run.pins),
        startedBy: run.started_by_name === null ? null : { id: run.created_by, name: run.started_by_name },
        viewerIsRequester: viewer?.id === row.requester_id,
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
    return this.gate2(id, actor, audit);
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
    const [latest, retests] = await Promise.all([
      audit ?? this.store.latestAudit(this.tenantId, 'finding', id),
      this.store.listRetests(this.tenantId, id, RETESTS_SHOWN),
    ]);
    return {
      ...findingDto(row, latest),
      retests: retests.map((r) => ({
        id: r.id,
        status: r.status,
        result: r.result,
        requestedBy: r.requested_by_name,
        createdAt: r.created_at.toISOString(),
        finishedAt: iso(r.finished_at),
        detail: scrubDeep(r.detail),
      })),
    };
  }

  /**
   * Asks the runner to replay a proven finding (probe and control) against the live site. Only probes that do not
   * change state: anything else needs a human at Gate 2, so it needs a new audit. Ownership is rechecked first.
   */
  async requestRetest(actor: DemoActor, id: string): Promise<{ retestId: string; status: 'queued' }> {
    requireRole(actor, ['appsec-engineer'], 'Only an AppSec engineer can retest a finding.');
    const finding = await this.finding(actor, id);
    if (finding.status !== 'confirmed' && finding.status !== 'released') {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'finding_not_retestable', 'Only a proven finding can be retested.');
    }
    const evidence = finding.evidence as { probe?: { request?: { method?: unknown } }; control?: { request?: { method?: unknown } } };
    const safe = (method: unknown): boolean => typeof method === 'string' && SAFE_METHODS.has(method.toUpperCase());
    const control = evidence.control?.request?.method;
    if (!safe(evidence.probe?.request?.method ?? finding.location.method) || (control !== undefined && !safe(control))) {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'retest_needs_gate2', 'Run the audit again to retest this one.');
    }
    await this.recheckOwnership(actor, await this.assetRow(finding.asset_id), 'retest');
    const retestId = newId();
    if (!(await this.store.insertRetest({ id: retestId, tenant_id: this.tenantId, finding_id: id, requested_by: actor.id }))) {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'retest_in_progress', 'A retest of this finding is already under way.');
    }
    await this.audit(actor, 'finding.retest', 'finding', id, { retestId, runId: finding.run_id });
    return { retestId, status: 'queued' };
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
    coverage: Record<string, unknown> | null;
    endReason: string | null;
    consoleOrigin: string;
  }> {
    const run = await this.runRow(runId);
    const [rows, ends] = await Promise.all([
      this.store.listFindingsForRun(this.tenantId, runId, false),
      this.store.lastEvents(runId, [...END_EVENT_KINDS, COVERAGE_KIND]),
    ]);
    const findings = rows.filter((f) => f.status === 'released');
    return {
      run,
      ...(await this.runContext(run)),
      findings,
      coverage: coverageOf(ends),
      endReason: endReasonOf(ends),
      consoleOrigin: this.webhook.consoleOrigin,
    };
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
    await this.store.appendEvent(finding.run_id, this.triageEvent(finding, to, actor, reason));
    if (decision === 'release') await this.deliver(finding, actor.name);
    return this.findingDetail(actor, id, audit);
  }

  /**
   * Batch Gate 3: the same conditional transition as {@link triage} for each id, one ledger event and one run
   * event per finding that moved. Webhook deliveries run after the response (a failure never fails a release).
   */
  async triageMany(
    actor: DemoActor,
    ids: readonly string[],
    decision: 'release' | 'dismiss',
    reason: string,
  ): Promise<{ results: TriageResult[]; moved: number; conflicts: number; failed: number }> {
    requireRole(actor, ['appsec-engineer'], 'Only an AppSec engineer can release or dismiss a finding.');
    const to = decision === 'release' ? 'released' : 'dismissed';
    const rows = new Map((await this.store.getFindings(this.tenantId, ids)).map((r) => [r.id, r]));
    const moved = new Set(
      await this.store.triageFindings(this.tenantId, [...rows.keys()], TRIAGE_FROM[decision], to, actor.id, reason),
    );
    const movedRows = [...rows.values()].filter((r) => moved.has(r.id));
    await this.store.appendAudits(
      this.tenantId,
      movedRows.map((f) => entryOf(actor, `finding.${decision}`, 'finding', f.id, { decision, reason, runId: f.run_id })),
    );
    for (const f of movedRows) await this.store.appendEvent(f.run_id, this.triageEvent(f, to, actor, reason));
    if (decision === 'release') {
      void Promise.all(movedRows.map((f) => this.deliver(f, actor.name))).catch((error: unknown) => {
        this.logger.warn({ event: 'demo.webhook.failed', reason: error instanceof Error ? error.name : 'Error' });
      });
    }
    const results: TriageResult[] = ids.map((id) =>
      moved.has(id)
        ? { id, ok: true, status: to }
        : { id, ok: false, code: rows.has(id) ? 'finding_not_triageable' : 'not_found' },
    );
    return {
      results,
      moved: moved.size,
      conflicts: results.filter((r) => r.code === 'finding_not_triageable').length,
      failed: results.filter((r) => r.code === 'not_found').length,
    };
  }

  private triageEvent(
    finding: FindingRow,
    to: 'released' | 'dismissed',
    actor: DemoActor,
    reason: string,
  ): { kind: string; stage: string; message: string; data: Record<string, unknown> } {
    const title = scrub(finding.title);
    return {
      kind: `finding.${to}`,
      stage: 'gate3',
      message: `${capitalise(to)} by ${actor.name}: ${title}`,
      data: {
        findingId: finding.id,
        title,
        severity: severityOf(finding.severity),
        ...(to === 'released' ? { auto: false } : {}),
        by: actor.id,
        reason,
      },
    };
  }

  /** POSTs the released finding to the optional webhook and records the result. A failure never fails the release. */
  private async deliver(finding: FindingRow, releasedBy: string): Promise<void> {
    const { webhookUrl, consoleOrigin } = this.webhook;
    if (webhookUrl === null) return;
    const url = `${consoleOrigin}/findings/${finding.id}`;
    const severity = severityOf(finding.severity);
    const asset = finding.asset_name ?? '';
    const clean = scrubFinding(finding);
    const body = {
      text: `Blackwing released a ${capitalise(severity)} finding on ${asset}: ${clean.title}. ${url}`,
      finding: {
        id: finding.id,
        title: clean.title,
        severity,
        cwe: finding.cwe_id,
        owasp: owaspLabel(finding.owasp_category),
        asset,
        url,
        reproCurl: clean.repro_curl,
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
