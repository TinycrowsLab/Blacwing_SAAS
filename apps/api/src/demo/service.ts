// DEMO-STORY business rules: assets, assessment requests, Gate 1 (separation of duties), run start and
// finding reads. Stubs are labelled in the code and in docs/runbooks/demo.md (real vs demo-stub).
import { createHash } from 'node:crypto';

import { HttpException, HttpStatus } from '@nestjs/common';

import { newId } from '@blackwing/ids';

import { DEMO_TEST_CASE, REFUSED_DEMO_CLASSES } from './catalogue.js';

import type { AssetRow, DemoStore, FindingRow, RequestRow, RunRow } from './store.js';

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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const RECENT_REQUESTS = 10;
const RECENT_ITEMS = 5;
const FINDING_LIST_LIMIT = 50;

/** Normalises a role name (Keycloak uses dashes, the seed uses underscores). */
function normaliseRole(role: string): string {
  return role.trim().toLowerCase().replace(/_/g, '-');
}

export function actorHasRole(actor: DemoActor, role: string): boolean {
  const wanted = normaliseRole(role);
  return actor.roles.some((r) => normaliseRole(r) === wanted);
}

export function fingerprintFor(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export interface AssetDto {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly ownership: { readonly status: string; readonly method: string | null; readonly basis: string };
}

export function assetDto(row: AssetRow): AssetDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    baseUrl: row.base_url,
    ownership: {
      status: row.ownership_status,
      method: row.verification_method,
      // DEMO-STUB: ownership is "verified" by lab trust for the local Juice Shop only (no DNS/HTTP proof).
      basis: row.verification_method === 'lab_trust' ? 'demo-stub: lab trust' : 'verified externally',
    },
  };
}

export function requestDto(row: RequestRow): Record<string, unknown> {
  return {
    id: row.id,
    assetId: row.asset_id,
    testCaseId: row.test_case_id,
    scope: row.scope,
    intrusiveness: row.intrusiveness,
    budget: { requests: row.budget_requests, seconds: row.budget_seconds },
    status: row.status,
    requester: { id: row.requester_id, name: row.requester_name },
    approver: row.approver_id === null ? null : { id: row.approver_id, name: row.approver_name },
    decisionReason: row.decision_reason,
    decidedAt: row.decided_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    runId: null,
  };
}

export function runDto(row: RunRow): Record<string, unknown> {
  return {
    id: row.id,
    requestId: row.request_id,
    state: row.state,
    requestsUsed: row.requests_used,
    budgetRequests: row.budget_requests,
    pins: row.pins,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export function findingDto(row: FindingRow): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    assetId: row.asset_id,
    fingerprint: row.fingerprint,
    title: row.title,
    testCaseId: row.test_case_id,
    class: row.class,
    cwe: row.cwe_id,
    owasp: row.owasp_category,
    status: row.status,
    confidence: Number(row.confidence),
    severity: row.severity,
    location: row.location,
    oracle: row.oracle,
    evidence: row.evidence,
    replay: row.replay,
    reproCurl: row.repro_curl,
    createdAt: row.created_at.toISOString(),
  };
}

export interface CreateRequestInput {
  readonly assetId: string;
  readonly testCaseId: string;
  readonly intrusiveness: string;
  readonly budgetRequests: number;
  readonly budgetSeconds: number;
  readonly scope: { readonly host: string; readonly pathPrefix: string };
}

export class DemoService {
  constructor(
    private readonly store: DemoStore,
    private readonly tenantId: string,
  ) {}

  async assets(): Promise<AssetDto[]> {
    return (await this.store.listAssets(this.tenantId)).map((row) => assetDto(row));
  }

  async dashboard(actor: DemoActor): Promise<Record<string, unknown>> {
    const [assets, requests, runs, findings] = await Promise.all([
      this.store.listAssets(this.tenantId),
      this.store.listRequests(this.tenantId, RECENT_REQUESTS),
      this.store.listRuns(this.tenantId, RECENT_ITEMS),
      this.store.listFindings(this.tenantId, RECENT_ITEMS),
    ]);
    return {
      tenant: { id: this.tenantId },
      actor: { id: actor.id, name: actor.name, roles: actor.roles },
      counts: {
        assets: assets.length,
        requestsPendingGate1: requests.filter((r) => r.status === 'pending_gate1').length,
        runs: runs.length,
        confirmedFindings: findings.length,
      },
      assets: assets.map((row) => assetDto(row)),
      requests: requests.map((row) => requestDto(row)),
      runs: runs.map((row) => runDto(row)),
      findings: findings.map((row) => findingDto(row)),
    };
  }

  async createRequest(actor: DemoActor, input: CreateRequestInput): Promise<Record<string, unknown>> {
    if (!actorHasRole(actor, 'appsec-engineer')) {
      throw new DemoRefusal(
        HttpStatus.FORBIDDEN,
        'role_required',
        'Only an appsec engineer can request an assessment.',
      );
    }
    if (input.testCaseId !== DEMO_TEST_CASE.id) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'unknown_test_case',
        `The demo only runs ${DEMO_TEST_CASE.id}.`,
      );
    }
    if ((REFUSED_DEMO_CLASSES as readonly string[]).includes(input.intrusiveness)) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'intrusiveness_refused',
        `Intrusiveness ${input.intrusiveness} is never allowed (destructive and state-changing classes are refused).`,
      );
    }
    if (input.intrusiveness === 'passive') {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'intrusiveness_below_test_case',
        `${DEMO_TEST_CASE.id} needs active_safe; a passive request cannot run it.`,
      );
    }
    const asset = await this.store.getAsset(this.tenantId, input.assetId);
    if (asset === null) {
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'asset_not_found', 'No such asset.');
    }
    if (asset.ownership_status !== 'verified') {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'asset_not_verified',
        'Ownership must be verified before an assessment can be requested.',
      );
    }
    const assetHost = new URL(asset.base_url).hostname;
    if (!LOOPBACK_HOSTS.has(assetHost)) {
      // The case refuses non-lab assets in policy (issue #881 acceptance criteria).
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'non_lab_asset_refused',
        'The demo case runs only against the local lab target.',
      );
    }
    if (input.scope.host !== assetHost) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'scope_outside_asset',
        `Scope host ${input.scope.host} is not the asset host ${assetHost}.`,
      );
    }
    if (!input.scope.pathPrefix.startsWith(DEMO_TEST_CASE.pathPrefix)) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'scope_outside_test_case',
        `Scope path must start with ${DEMO_TEST_CASE.pathPrefix}.`,
      );
    }
    // The probe, the replay (x2) and the negative control need four requests.
    const minimumRequests = 1 + DEMO_TEST_CASE.replayCount + 1;
    if (input.budgetRequests < minimumRequests) {
      throw new DemoRefusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'budget_too_small',
        `The case needs at least ${minimumRequests} requests.`,
      );
    }
    const id = newId();
    await this.store.insertRequest({
      id,
      tenant_id: this.tenantId,
      asset_id: asset.id,
      requester_id: actor.id,
      test_case_id: DEMO_TEST_CASE.id,
      scope: {
        method: DEMO_TEST_CASE.method,
        host: input.scope.host,
        pathPrefix: input.scope.pathPrefix,
        parameter: DEMO_TEST_CASE.parameter,
      },
      intrusiveness: input.intrusiveness,
      budget_requests: input.budgetRequests,
      budget_seconds: input.budgetSeconds,
      status: 'pending_gate1',
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
    if (!actorHasRole(actor, 'asset-owner')) {
      throw new DemoRefusal(
        HttpStatus.FORBIDDEN,
        'role_required',
        'Only an asset owner can decide Gate 1.',
      );
    }
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
    if (!actorHasRole(actor, 'appsec-engineer')) {
      throw new DemoRefusal(HttpStatus.FORBIDDEN, 'role_required', 'Only an appsec engineer starts a run.');
    }
    const row = await this.store.getRequest(this.tenantId, requestId);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such request.');
    if (row.status !== 'approved') {
      throw new DemoRefusal(
        HttpStatus.CONFLICT,
        'gate1_not_approved',
        `The request is ${row.status}; a run needs Gate 1 approval first.`,
      );
    }
    const asset = await this.store.getAsset(this.tenantId, row.asset_id);
    if (asset?.ownership_status !== 'verified') {
      throw new DemoRefusal(HttpStatus.UNPROCESSABLE_ENTITY, 'asset_not_verified', 'Asset ownership is not verified.');
    }
    if (!(await this.store.claimRequestForRun(this.tenantId, requestId))) {
      throw new DemoRefusal(HttpStatus.CONFLICT, 'run_already_started', 'This request already has a run.');
    }
    const runId = newId();
    const pins = {
      asset: {
        id: asset.id,
        slug: asset.slug,
        name: asset.name,
        baseUrl: asset.base_url,
        ownership: { status: asset.ownership_status, method: asset.verification_method },
      },
      scope: row.scope,
      request: {
        id: row.id,
        intrusiveness: row.intrusiveness,
        budget: { requests: row.budget_requests, seconds: row.budget_seconds },
        approverId: row.approver_id,
        decidedAt: row.decided_at?.toISOString() ?? null,
      },
      testCase: DEMO_TEST_CASE,
      runner: { name: 'demo-replay', version: '1' },
      stubs: {
        planner: 'demo-planner: deterministic, selects the pinned test case; no model call',
        specialist: 'demo-specialist: fixed hypothesis that names the same test case and oracle id; no model call',
        egress: 'demo-stub: no egress gateway; the runner talks to the lab target directly',
        sandbox: 'demo-stub: no sandbox; the runner runs in the demo worker process',
      },
    };
    await this.store.insertRun({
      id: runId,
      tenant_id: this.tenantId,
      request_id: requestId,
      created_by: actor.id,
      pins,
      budget_requests: row.budget_requests,
    });
    await this.store.appendEvent(runId, 1, {
      kind: 'run.queued',
      stage: 'queued',
      message: 'Run accepted. Pins recorded: test case, oracle, runner version and lab target.',
      data: { testCaseId: DEMO_TEST_CASE.id, oracleId: DEMO_TEST_CASE.oracle.id },
    });
    return { id: runId, requestId, state: 'queued' };
  }

  async run(runId: string, afterSeq: number): Promise<Record<string, unknown>> {
    const row = await this.store.getRun(this.tenantId, runId);
    if (row === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No such run.');
    const [events, finding] = await Promise.all([
      this.store.listEvents(runId, afterSeq),
      this.store.findingForRun(this.tenantId, runId),
    ]);
    const lastSeq = events.at(-1)?.seq ?? afterSeq;
    return {
      ...runDto(row),
      lastSeq,
      events: events.map((e) => ({
        seq: e.seq,
        kind: e.kind,
        stage: e.stage,
        message: e.message,
        data: e.data,
        at: e.at.toISOString(),
      })),
      findingId: finding?.id ?? null,
    };
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
    const run = await this.store.getRun(this.tenantId, finding.run_id);
    if (run === null) throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'No run for this finding.');
    const request = await this.store.getRequest(this.tenantId, run.request_id);
    const asset = await this.store.getAsset(this.tenantId, finding.asset_id);
    if (request === null || asset === null) {
      throw new DemoRefusal(HttpStatus.NOT_FOUND, 'not_found', 'The finding has no request or asset.');
    }
    return { finding, run, asset, request };
  }

  async listFindings(): Promise<Record<string, unknown>[]> {
    return (await this.store.listFindings(this.tenantId, FINDING_LIST_LIMIT)).map((row) => findingDto(row));
  }
}
