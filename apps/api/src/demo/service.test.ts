// DEMO-STORY unit tests: the pure rules of the demo API (no database): roles, origins, kill confirmation,
// the Gate 2 countdown and the ownership proof.
import { describe, expect, it, vi } from 'vitest';

import { amendRequestSchema, gate2DecisionSchema, triageManySchema, workspaceSchema } from './controller.js';
import {
  ALL_ROLES,
  DemoRefusal,
  DemoService,
  actorHasRole,
  assetDto,
  exchangeDto,
  findingDto,
  gate2Dto,
  originsOf,
  owaspLabel,
  runDto,
  secondsLeft,
  shortId,
} from './service.js';

import type { Lookup, OriginPolicy } from './ownership.js';
import type { AssetRow, DemoStore, FindingRow, Gate2Row, RequestRow, RunRow } from './store.js';

/** Labs on loopback, the console on :3000 and the API on :13400 (the launcher's defaults). */
const policy: OriginPolicy = {
  labOrigins: ['http://127.0.0.1:3001'],
  platformOrigins: ['http://localhost:3000', 'http://127.0.0.1:13400'],
  platformPorts: [3000, 13400, 13401],
};
/** app.example.com and friends resolve to a public documentation address; IP literals resolve to themselves. */
const lookup: Lookup = (host) => Promise.resolve([/^[\d.]+$/.test(host) || host.includes(':') ? host : '93.184.216.34']);
const options = { gate2TimeoutS: 300, origins: policy, lookup };
const webhookOff = { webhookUrl: null, consoleOrigin: 'http://localhost:3000' };

describe('actorHasRole', () => {
  it('accepts the Keycloak dash form and the seed underscore form', () => {
    const dashed = { id: 'u1', email: 'a@acme.test', name: 'A', roles: ['asset-owner'] };
    const underscored = { id: 'u2', email: 'b@acme.test', name: 'B', roles: ['appsec_engineer'] };
    expect(actorHasRole(dashed, 'asset-owner')).toBe(true);
    expect(actorHasRole(underscored, 'appsec-engineer')).toBe(true);
    expect(actorHasRole(dashed, 'appsec-engineer')).toBe(false);
  });
});

describe('originsOf', () => {
  it('reduces URLs to scheme, host and port and removes duplicates', () => {
    expect(
      originsOf(['https://shop.example.com/app?q=1', 'https://shop.example.com/', 'https://api.example.com:8443/v1']),
    ).toEqual(['https://shop.example.com', 'https://api.example.com:8443']);
  });
});

describe('secondsLeft', () => {
  const now = new Date('2026-11-05T10:00:00Z');
  it('rounds up and never goes below zero', () => {
    expect(secondsLeft(new Date('2026-11-05T10:00:01.200Z'), now)).toBe(2);
    expect(secondsLeft(new Date('2026-11-05T09:59:00Z'), now)).toBe(0);
  });
});

const asset = (token: string | null): AssetRow => ({
  id: 'a1',
  tenant_id: 't1',
  slug: 'x',
  name: 'X',
  base_url: 'https://app.example.com/base',
  ownership_status: 'unverified',
  verification_method: null,
  allowed_origins: ['https://app.example.com'],
  excluded_paths: [],
  verification_token: token,
  verified_by: null,
  verified_at: null,
  verified_by_name: null,
  created_at: new Date(),
});

const owner = { id: 'u1', email: 'o@acme.test', name: 'Owner', roles: ['asset-owner'] };

function serviceWith(row: AssetRow, response: Response | Error) {
  const store = {
    getAsset: vi.fn().mockResolvedValue(row),
    markAssetVerified: vi.fn().mockResolvedValue(true),
    appendAudit: vi.fn().mockResolvedValue({ eventId: 'e1', hash: 'h1' }),
  };
  const fetchImpl = vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));
  return { store, service: new DemoService(store as unknown as DemoStore, 't1', fetchImpl, webhookOff, options) };
}

describe('verifyAsset http_token', () => {
  it('fetches the well-known file on the origin without following redirects and accepts the token', async () => {
    const { store, service } = serviceWith(asset('abc123'), new Response('proof abc123\n'));
    await service.verifyAsset(owner, 'a1', { method: 'http_token' });
    expect(store.markAssetVerified).toHaveBeenCalledWith('t1', 'a1', 'http_token', 'u1');
  });

  it.each([
    ['wrong content', new Response('nope')],
    ['404', new Response('abc123', { status: 404 })],
    ['network error', new Error('down')],
  ])('refuses on %s', async (_name, response) => {
    const { store, service } = serviceWith(asset('abc123'), response);
    await expect(service.verifyAsset(owner, 'a1', { method: 'http_token' })).rejects.toMatchObject({
      response: { code: 'verification_failed' },
    });
    expect(store.markAssetVerified).not.toHaveBeenCalled();
  });

  it('only an asset owner may verify', async () => {
    const { service } = serviceWith(asset('abc123'), new Response('abc123'));
    const engineer = { ...owner, roles: ['appsec-engineer'] };
    await expect(service.verifyAsset(engineer, 'a1', { method: 'owner_attestation' })).rejects.toBeInstanceOf(DemoRefusal);
  });
});

describe('kill', () => {
  const run = { id: '0197a5d0-aaaa-7000-8000-000000000001' };
  const actor = { id: 'u2', email: 'a@acme.test', name: 'A', roles: [] };

  function killService() {
    const store = {
      getRun: vi.fn().mockResolvedValue(run),
      killQueuedRun: vi.fn().mockResolvedValue(null),
      requestKill: vi.fn().mockResolvedValue(new Date('2026-11-05T10:00:00Z')),
      appendEvent: vi.fn(),
      appendAudit: vi.fn().mockResolvedValue({ eventId: 'e1', hash: 'h1' }),
    };
    return { store, service: new DemoService(store as unknown as DemoStore, 't1') };
  }

  it('requires the run short id, case-insensitively, and flags a running run for the worker', async () => {
    const { store, service } = killService();
    await expect(service.kill(actor, run.id, 'wrong')).rejects.toMatchObject({
      response: { code: 'kill_confirmation_mismatch' },
    });
    expect(store.requestKill).not.toHaveBeenCalled();
    const result = await service.kill(actor, run.id, shortId(run.id).toUpperCase());
    expect(result.killRequestedAt).toBe('2026-11-05T10:00:00.000Z');
    expect(result.audit).toEqual({ eventId: 'e1', hash: 'h1' });
    expect(store.appendAudit).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ action: 'run.kill', payload: { confirm: shortId(run.id).toUpperCase(), queued: false } }),
    );
  });
});

describe('createAsset', () => {
  const engineer = { ...owner, roles: ['appsec-engineer'] };
  const input = { name: 'Again', baseUrl: 'https://app.example.com/other', extraOrigins: [], excludedPaths: [] };

  it('returns the existing asset for an origin that is already registered and inserts nothing', async () => {
    const store = { listAssets: vi.fn().mockResolvedValue([asset('abc')]), insertAsset: vi.fn() };
    const service = new DemoService(store as unknown as DemoStore, 't1', fetch, webhookOff, options);
    const dto = await service.createAsset(engineer, input);
    expect(dto.id).toBe('a1');
    expect(store.insertAsset).not.toHaveBeenCalled();
  });
});

describe('Gate 2 decision body', () => {
  it('needs a reason of at least 8 characters to approve, and none to deny', () => {
    expect(gate2DecisionSchema.safeParse({ decision: 'approve' }).success).toBe(false);
    expect(gate2DecisionSchema.safeParse({ decision: 'approve', reason: ' short ' }).success).toBe(false);
    expect(gate2DecisionSchema.safeParse({ decision: 'approve', reason: 'safe, read-only probe' }).success).toBe(true);
    expect(gate2DecisionSchema.safeParse({ decision: 'deny' }).success).toBe(true);
  });
});

describe('triage', () => {
  const engineer = { ...owner, roles: ['appsec-engineer'] };
  const finding = (status: string) =>
    ({
      id: 'f1',
      run_id: 'r1',
      title: 'IDOR',
      severity: 'high',
      status,
      asset_name: 'X',
      confidence: '0.9',
      triaged_at: null,
      delivery_status: null,
      created_at: new Date(),
      seen_at: null,
      evidence: {},
      replay: {},
      oracle: {},
      location: {},
      repro_curl: 'curl x',
      description: null,
    }) as unknown as FindingRow;

  function triageService(status: string, transitioned: boolean) {
    const store = {
      getFinding: vi.fn().mockResolvedValue(finding(status)),
      triageFinding: vi.fn().mockResolvedValue(transitioned),
      appendAudit: vi.fn().mockResolvedValue({ eventId: 'e1', hash: 'h1' }),
      appendEvent: vi.fn(),
      latestAudit: vi.fn(),
      recordDelivery: vi.fn(),
    };
    return { store, service: new DemoService(store as unknown as DemoStore, 't1') };
  }

  it('only an AppSec engineer may triage', async () => {
    const { store, service } = triageService('suspected', true);
    await expect(service.triage(owner, 'f1', 'release', 'real issue, confirmed by hand')).rejects.toMatchObject({
      response: { code: 'role_required' },
    });
    expect(store.triageFinding).not.toHaveBeenCalled();
  });

  it('releases a suspected finding, appends the audit and run event, and skips delivery without a webhook', async () => {
    const { store, service } = triageService('suspected', true);
    const dto = await service.triage(engineer, 'f1', 'release', 'real issue, confirmed by hand');
    expect(store.triageFinding).toHaveBeenCalledWith('t1', 'f1', ['suspected', 'confirmed'], 'released', 'u1', 'real issue, confirmed by hand');
    expect(store.appendEvent).toHaveBeenCalledWith('r1', expect.objectContaining({ kind: 'finding.released' }));
    expect(store.recordDelivery).not.toHaveBeenCalled();
    expect(dto.audit).toEqual({ eventId: 'e1', hash: 'h1' });
  });

  it('refuses a transition the conditional update rejects', async () => {
    const { service } = triageService('dismissed', false);
    await expect(service.triage(engineer, 'f1', 'release', 'second thoughts here')).rejects.toMatchObject({
      response: { code: 'finding_not_triageable' },
    });
  });

  it('records the webhook result without ever failing the release', async () => {
    const { store } = triageService('suspected', true);
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('slow', 'TimeoutError'));
    const service = new DemoService(store as unknown as DemoStore, 't1', fetchImpl, {
      webhookUrl: 'https://hooks.example.com/x',
      consoleOrigin: 'http://localhost:3000',
    });
    await service.triage(engineer, 'f1', 'release', 'real issue, confirmed by hand');
    expect(store.recordDelivery).toHaveBeenCalledWith('f1', 'failed', 'TimeoutError');
  });

  it('hides a suspected finding from a non-AppSec actor', async () => {
    const { service } = triageService('suspected', true);
    await expect(service.finding(owner, 'f1')).rejects.toMatchObject({ response: { code: 'not_found' } });
  });
});

describe('run events', () => {
  it('hides finding.suspected events from a non-AppSec actor', async () => {
    const at = new Date();
    const store = {
      getRun: vi.fn().mockResolvedValue({ id: 'r1', state: 'running', created_at: at, started_at: null, finished_at: null, kill_requested_at: null }),
      listEvents: vi.fn().mockResolvedValue([
        { seq: 1, kind: 'http.sent', stage: 'recon', message: 'GET', data: {}, at },
        { seq: 2, kind: 'finding.suspected', stage: 'validator', message: 'Suspected: T', data: {}, at },
      ]),
      listFindingsForRun: vi.fn().mockResolvedValue([]),
      listGate2ForRun: vi.fn().mockResolvedValue([]),
      runStats: vi.fn().mockResolvedValue({}),
      lastEvents: vi.fn().mockResolvedValue([]),
    };
    const service = new DemoService(store as unknown as DemoStore, 't1');
    const view = async (roles: string[]) =>
      ((await service.run({ ...owner, roles }, 'r1', 0)) as { events: { kind: string }[]; lastSeq: number });
    expect((await view(['asset-owner'])).events.map((e) => e.kind)).toEqual(['http.sent']);
    expect((await view(['asset-owner'])).lastSeq).toBe(2);
    expect((await view(['appsec-engineer'])).events.map((e) => e.kind)).toEqual(['http.sent', 'finding.suspected']);
  });
});

describe('demo admin self-approval', () => {
  const requester = { id: 'u1', email: 'a@acme.test', name: 'A', roles: ['appsec-engineer', 'asset-owner'] };
  const admin = { ...requester, roles: [...ALL_ROLES], admin: true };
  const requestRow = (status: string) =>
    ({
      id: 'q1',
      asset_id: 'a1',
      status,
      requester_id: 'u1',
      approver_id: null,
      scope: {},
      test_accounts: [],
      budget_requests: 1,
      budget_seconds: 1,
      cost_cap_usd: '1',
      created_at: new Date(),
    }) as unknown as RequestRow;

  const adminOverride: unknown = expect.objectContaining({ selfApproved: true, override: 'admin' });
  const labAsset: AssetRow = {
    ...asset(null),
    base_url: 'http://127.0.0.1:3001',
    allowed_origins: ['http://127.0.0.1:3001'],
    ownership_status: 'verified',
    verification_method: 'owner_attestation',
  };

  function service(extra: Record<string, unknown> = {}) {
    const store = {
      getRequest: vi.fn().mockResolvedValue(requestRow('pending_gate1')),
      decideRequest: vi.fn().mockResolvedValue(true),
      findRunByRequest: vi.fn().mockResolvedValue(null),
      appendAudit: vi.fn().mockResolvedValue({ eventId: 'e1', hash: 'h1' }),
      getAsset: vi.fn().mockResolvedValue(labAsset),
      latestAudit: vi.fn().mockResolvedValue(null),
      ...extra,
    };
    return { store, service: new DemoService(store as unknown as DemoStore, 't1', fetch, webhookOff, options) };
  }

  it('lets the admin approve its own Gate 1 request and marks it in the audit payload', async () => {
    const { store, service: s } = service();
    await s.decideGate1(admin, 'q1', 'approve', null);
    expect(store.decideRequest).toHaveBeenCalled();
    expect(store.appendAudit).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ payload: adminOverride }),
    );
  });

  it('still refuses a non-admin requester at Gate 1', async () => {
    const { store, service: s } = service();
    await expect(s.decideGate1(requester, 'q1', 'approve', null)).rejects.toMatchObject({
      response: { code: 'separation_of_duties' },
    });
    expect(store.decideRequest).not.toHaveBeenCalled();
  });

  it('lets the admin approve its own Gate 2 request and marks it in the audit payload', async () => {
    const gate2 = {
      id: 'g1',
      run_id: 'r1',
      method: 'POST',
      url: 'https://app.example.com/x',
      status: 'pending',
      created_at: new Date(),
      deadline_at: new Date(Date.now() + 60_000),
    };
    const { store, service: s } = service({
      getGate2: vi.fn().mockResolvedValue(gate2),
      getRun: vi.fn().mockResolvedValue({ id: 'r1', request_id: 'q1', state: 'running', pins: {} }),
      decideGate2: vi.fn().mockResolvedValue(true),
    });
    await s.decideGate2(admin, 'g1', 'approve', 'safe, read-only probe');
    expect(store.appendAudit).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ payload: adminOverride }),
    );
  });
});

describe('workspace (B1)', () => {
  const admin = { id: 'u1', email: 'a@x.test', name: 'A', roles: [...ALL_ROLES], admin: true };
  const member = { id: 'u2', email: 'b@x.test', name: 'B', roles: ['appsec-engineer'] };

  function workspaceService(name: string) {
    const store = {
      getTenant: vi.fn().mockResolvedValue({ id: 't1', name }),
      renameTenant: vi.fn().mockResolvedValue(true),
      appendAudit: vi.fn().mockResolvedValue({ eventId: 'e1', hash: 'h1' }),
    };
    const service = new DemoService(
      store as unknown as DemoStore,
      't1',
      fetch,
      { webhookUrl: 'https://hooks.example.com/services/SECRET', consoleOrigin: 'http://console.test' },
      { gate2TimeoutS: 120 },
    );
    return { store, service };
  }

  it('reports an unnamed workspace as null and exposes the settings the console needs, never the webhook URL', async () => {
    const { service } = workspaceService('');
    const dto = await service.workspace(admin);
    expect(dto).toMatchObject({
      id: 't1',
      name: null,
      settings: {
        gate2TimeoutS: 120,
        selfApprove: true,
        limits: { requests: { min: 10, max: 5000 }, minutes: { min: 1, max: 120 } },
        webhook: { configured: true, host: 'hooks.example.com' },
      },
    });
    expect(JSON.stringify(dto)).not.toContain('SECRET');
    expect((await service.workspace(member)).settings).toMatchObject({ selfApprove: false });
  });

  it('keeps every preset inside the limits', async () => {
    const { service } = workspaceService('Tinycrows');
    const { settings } = (await service.workspace(admin)) as {
      settings: { presets: { minutes: number; requests: number; costUsd: number }[] };
    };
    expect(settings.presets.map((p) => p.minutes)).toEqual([10, 30, 120]);
    for (const p of settings.presets) {
      expect(p.requests).toBeGreaterThanOrEqual(10);
      expect(p.requests).toBeLessThanOrEqual(5000);
      expect(p.costUsd).toBeLessThanOrEqual(100);
    }
  });

  it('lets an administrator name the workspace and records it in the ledger', async () => {
    const { store, service } = workspaceService('Tinycrows');
    await service.renameWorkspace(admin, 'Tinycrows');
    expect(store.renameTenant).toHaveBeenCalledWith('t1', 'Tinycrows');
    expect(store.appendAudit).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ action: 'workspace.named', targetType: 'tenant', payload: { name: 'Tinycrows' } }),
    );
  });

  it('refuses a non-administrator', async () => {
    const { store, service } = workspaceService('');
    await expect(service.renameWorkspace(member, 'Mine')).rejects.toMatchObject({
      response: { code: 'admin_required' },
    });
    expect(store.renameTenant).not.toHaveBeenCalled();
  });

  it('validates the name: trimmed, 2 to 60 characters', () => {
    expect(workspaceSchema.parse({ name: '  Tinycrows  ' })).toEqual({ name: 'Tinycrows' });
    expect(workspaceSchema.safeParse({ name: ' a ' }).success).toBe(false);
    expect(workspaceSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
  });

  it('adds the tenant name to the dashboard', async () => {
    const store = {
      getTenant: vi.fn().mockResolvedValue({ id: 't1', name: 'Tinycrows' }),
      dashboardCounts: vi.fn().mockResolvedValue({ assets: 0, requestsPendingGate1: 0, runsRunning: 0, confirmedFindings: 0 }),
      listAssets: vi.fn().mockResolvedValue([]),
      listPendingGate1: vi.fn().mockResolvedValue([]),
      listRuns: vi.fn().mockResolvedValue([]),
      listFindings: vi.fn().mockResolvedValue([]),
      listPendingGate2: vi.fn().mockResolvedValue([]),
      pendingCounts: vi.fn().mockResolvedValue({ gate1: 3, gate2: 1, gate3: 56, keptBack: 7, live: 2 }),
      listLiveRuns: vi.fn().mockResolvedValue([]),
    };
    const service = new DemoService(store as unknown as DemoStore, 't1');
    const dashboard = await service.dashboard(admin);
    expect(dashboard.tenant).toEqual({ id: 't1', name: 'Tinycrows' });
    expect(dashboard.pendingCounts).toEqual({ gate1: 3, gate2: 1, gate3: 56, keptBack: 7, live: 2 });
    expect(store.pendingCounts).toHaveBeenCalledWith('t1', true);
    expect(dashboard.liveRuns).toEqual([]);
  });
});

describe('release mode (B3) and retest clone (B5)', () => {
  const engineer = { id: 'u1', email: 'a@x.test', name: 'A', roles: ['appsec-engineer'] };
  const verified = { ...asset('tok'), ownership_status: 'verified' };
  const stored = (scope: Record<string, unknown>) =>
    ({
      id: 'q1',
      asset_id: 'a1',
      asset_name: 'X',
      requester_id: 'u1',
      requester_name: 'A',
      approver_id: null,
      approver_name: null,
      objective: 'Look for injection.',
      scope,
      intrusiveness: 'passive',
      budget_requests: 300,
      budget_seconds: 600,
      cost_cap_usd: '3',
      test_accounts: [{ role: 'customer_a', header_name: 'Authorization', header_value: 'Bearer secret-a' }],
      status: 'completed',
      decision_reason: null,
      decided_at: null,
      created_at: new Date(),
    }) as unknown as RequestRow;

  function requestService(row: RequestRow) {
    const store = {
      getAsset: vi.fn().mockResolvedValue(verified),
      insertRequest: vi.fn().mockResolvedValue(undefined),
      getRequest: vi.fn().mockResolvedValue(row),
      findRunByRequest: vi.fn().mockResolvedValue(null),
      latestAudit: vi.fn().mockResolvedValue(null),
    };
    return { store, service: new DemoService(store as unknown as DemoStore, 't1') };
  }

  it('stores the release mode in the request scope and exposes it in the DTO', async () => {
    const { store, service } = requestService(stored({ excludedPaths: [], releaseProven: 'auto' }));
    const dto = await service.createRequest(engineer, {
      assetId: 'a1',
      objective: 'x',
      intrusiveness: 'active_safe',
      budgetRequests: 300,
      budgetSeconds: 600,
      costCapUsd: 3,
      excludedPaths: [],
      releaseProven: 'auto',
      testAccounts: [],
    });
    expect(store.insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { excludedPaths: [], releaseProven: 'auto' } }),
    );
    expect(dto.releaseProven).toBe('auto');
  });

  it('treats a request created before release modes as auto (unchanged behaviour)', async () => {
    const { service } = requestService(stored({ excludedPaths: [] }));
    expect((await service.request('q1')).releaseProven).toBe('auto');
  });

  it('clones a request with its answers and test-account values kept server-side', async () => {
    const { store, service } = requestService(stored({ excludedPaths: ['/admin'], releaseProven: 'hold' }));
    const dto = await service.cloneRequest(engineer, 'q1');
    expect(store.insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        asset_id: 'a1',
        objective: 'Look for injection.',
        intrusiveness: 'passive',
        budget_requests: 300,
        budget_seconds: 600,
        cost_cap_usd: 3,
        scope: { excludedPaths: ['/admin'], releaseProven: 'hold' },
        test_accounts: [{ role: 'customer_a', header_name: 'Authorization', header_value: 'Bearer secret-a' }],
      }),
    );
    expect(JSON.stringify(dto)).not.toContain('secret-a');
    expect(dto.testAccounts).toEqual([{ role: 'customer_a', headerName: 'Authorization' }]);
  });

  it('refuses a clone without the appsec role', async () => {
    const { store, service } = requestService(stored({}));
    await expect(service.cloneRequest({ ...engineer, roles: ['auditor'] }, 'q1')).rejects.toBeInstanceOf(DemoRefusal);
    expect(store.insertRequest).not.toHaveBeenCalled();
  });
});

describe('ownership allow-list and recheck (P0-5a)', () => {
  const engineer = { id: 'u1', email: 'a@x.test', name: 'A', roles: ['appsec-engineer'] };
  const approver = { id: 'u2', email: 'o@x.test', name: 'O', roles: ['asset-owner'] };
  const lab: AssetRow = {
    ...asset('tok'),
    base_url: 'http://127.0.0.1:3001',
    allowed_origins: ['http://127.0.0.1:3001'],
    ownership_status: 'verified',
    verification_method: 'owner_attestation',
  };
  const pending = {
    id: 'q1',
    asset_id: 'a1',
    status: 'pending_gate1',
    version: 2,
    requester_id: 'u1',
    approver_id: null,
    approver_name: 'O',
    objective: 'Look.',
    scope: {},
    intrusiveness: 'passive',
    test_accounts: [],
    budget_requests: 100,
    budget_seconds: 600,
    cost_cap_usd: '3',
    created_at: new Date(),
  } as unknown as RequestRow;

  function storeWith(row: AssetRow, extra: Record<string, unknown> = {}) {
    return {
      getAsset: vi.fn().mockResolvedValue(row),
      listAssets: vi.fn().mockResolvedValue([]),
      insertAsset: vi.fn(),
      markAssetVerified: vi.fn().mockResolvedValue(true),
      markAssetUnverified: vi.fn().mockResolvedValue(true),
      appendAudit: vi.fn().mockResolvedValue({ eventId: 'e1', hash: 'h1' }),
      getRequest: vi.fn().mockResolvedValue(pending),
      decideRequest: vi.fn().mockResolvedValue(true),
      findRunByRequest: vi.fn().mockResolvedValue(null),
      latestAudit: vi.fn().mockResolvedValue({ eventId: 'approve-1', hash: 'h0' }),
      claimRequestForRun: vi.fn().mockResolvedValue(true),
      insertRun: vi.fn(),
      appendEvent: vi.fn(),
      ...extra,
    };
  }
  const make = (store: ReturnType<typeof storeWith>, fetchImpl: typeof fetch = fetch) =>
    new DemoService(store as unknown as DemoStore, 't1', fetchImpl, webhookOff, options);

  it.each([
    ['http://localhost:3000', 'own console'],
    ['http://169.254.169.254/latest', 'Cloud metadata'],
    ['http://127.0.0.1:8091', 'listed it as a lab'],
  ])('refuses to register %s', async (baseUrl, words) => {
    const store = storeWith(lab);
    const refusal = make(store).createAsset(engineer, { name: 'x', baseUrl, extraOrigins: [], excludedPaths: [] });
    await expect(refusal).rejects.toMatchObject({ response: { code: 'target_not_allowed' } });
    await expect(refusal).rejects.toMatchObject({ response: { detail: expect.stringContaining(words) as unknown } });
    expect(store.insertAsset).not.toHaveBeenCalled();
  });

  it('refuses an extra origin that points somewhere private even when the base URL is public', async () => {
    const store = storeWith(lab);
    await expect(
      make(store).createAsset(engineer, {
        name: 'x',
        baseUrl: 'https://app.example.com',
        extraOrigins: ['http://10.0.0.8'],
        excludedPaths: [],
      }),
    ).rejects.toMatchObject({ response: { code: 'target_not_allowed' } });
  });

  it('offers owner attestation only for a lab, and ledgers the proof', async () => {
    expect(assetDtoOf(lab).verification).toMatchObject({ methods: ['http_token', 'owner_attestation'] });
    expect(assetDtoOf(lab).lab).toBe(true);
    expect(assetDtoOf(asset('t')).verification).toMatchObject({ methods: ['http_token'] });

    const publicStore = storeWith(asset('t'));
    await expect(
      make(publicStore).verifyAsset(approver, 'a1', { method: 'owner_attestation', statement: 'I own this site.' }),
    ).rejects.toMatchObject({ response: { code: 'attestation_not_allowed' } });

    const labStore = storeWith({ ...lab, ownership_status: 'unverified' });
    await make(labStore).verifyAsset(approver, 'a1', { method: 'owner_attestation', statement: 'Our local lab.' });
    expect(labStore.appendAudit).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        action: 'asset.verified',
        targetType: 'asset',
        payload: { method: 'owner_attestation', origin: 'http://127.0.0.1:3001', tokenPath: null, statement: 'Our local lab.', lab: true },
      }),
    );
  });

  it('rechecks the well-known file at Gate 1: a vanished file un-verifies the asset and leaves the request pending', async () => {
    const tokenAsset: AssetRow = { ...asset('tok'), ownership_status: 'verified', verification_method: 'http_token' };
    const store = storeWith(tokenAsset);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('gone', { status: 404 })));
    await expect(make(store, fetchImpl).decideGate1(approver, 'q1', 'approve', null)).rejects.toMatchObject({
      response: { code: 'ownership_recheck_failed', detail: expect.stringContaining('the file is gone (the site answered 404)') as unknown },
    });
    expect(store.decideRequest).not.toHaveBeenCalled();
    expect(store.markAssetUnverified).toHaveBeenCalledWith('t1', 'a1');
    expect(store.appendAudit).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ action: 'asset.unverified', payload: expect.objectContaining({ at: 'gate1' }) as unknown }),
    );
  });

  it('rechecks at run start: an attested asset that is no longer a lab cannot start', async () => {
    const store = storeWith({ ...lab, base_url: 'http://127.0.0.1:8091', allowed_origins: ['http://127.0.0.1:8091'] }, {
      getRequest: vi.fn().mockResolvedValue({ ...pending, status: 'approved' }),
    });
    await expect(make(store).startRun(engineer, 'q1')).rejects.toMatchObject({
      response: { code: 'ownership_recheck_failed' },
    });
    expect(store.claimRequestForRun).not.toHaveBeenCalled();
  });

  it('pins the lab origins, drops the signing key id, and ledgers run.started with the approval', async () => {
    const store = storeWith(lab, { getRequest: vi.fn().mockResolvedValue({ ...pending, status: 'approved' }) });
    const started = await make(store).startRun(engineer, 'q1');
    const pins = (store.insertRun.mock.calls[0]?.[0] as { pins: { asset: { labOrigins: string[] }; authorisation: Record<string, unknown> } }).pins;
    expect(pins.asset.labOrigins).toEqual(['http://127.0.0.1:3001']);
    expect(pins.authorisation).not.toHaveProperty('keyId');
    expect(store.latestAudit).toHaveBeenCalledWith('t1', 'request', 'q1', 'gate1.approve');
    expect(store.appendAudit).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        action: 'run.started',
        targetId: started.id,
        payload: { requestId: 'q1', approvalEventId: 'approve-1', version: 2, labOrigins: 'http://127.0.0.1:3001' },
      }),
    );
  });

  it('refuses a second run for an approval that already has one', async () => {
    const store = storeWith(lab, {
      getRequest: vi.fn().mockResolvedValue({ ...pending, status: 'approved' }),
      findRunByRequest: vi.fn().mockResolvedValue({ id: 'r0' }),
    });
    await expect(make(store).startRun(engineer, 'q1')).rejects.toMatchObject({ response: { code: 'run_already_started' } });
    expect(store.claimRequestForRun).not.toHaveBeenCalled();
  });

  it('refuses a Gate 1 decision on an older plan version', async () => {
    const store = storeWith(lab);
    await expect(make(store).decideGate1(approver, 'q1', 'approve', null, 1)).rejects.toMatchObject({
      response: { code: 'plan_changed' },
    });
    await make(store).decideGate1(approver, 'q1', 'approve', null, 2);
    expect(store.decideRequest).toHaveBeenCalledWith('t1', 'q1', 'u2', 'approved', null, 2);
    expect(store.appendAudit).toHaveBeenCalledWith('t1', expect.objectContaining({ payload: expect.objectContaining({ version: 2 }) as unknown }));
  });
});

const assetDtoOf = (row: AssetRow): Record<string, unknown> => assetDto(row, policy);

describe('PATCH /requests/:id (P0-8a)', () => {
  const engineer = { id: 'u1', email: 'a@x.test', name: 'A', roles: ['appsec-engineer'] };
  const row = {
    id: 'q1',
    asset_id: 'a1',
    status: 'pending_gate1',
    version: 3,
    requester_id: 'u1',
    objective: 'Look.',
    scope: { excludedPaths: ['/setup.php'], releaseProven: 'hold' },
    intrusiveness: 'passive',
    test_accounts: [{ role: 'alice', header_name: 'Authorization', header_value: 'Bearer alice-secret' }],
    budget_requests: 300,
    budget_seconds: 900,
    cost_cap_usd: '4.00',
    created_at: new Date(),
  } as unknown as RequestRow;

  function amendService(amended: number | null = 4, now: RequestRow = row) {
    const store = {
      getRequest: vi.fn().mockResolvedValueOnce(row).mockResolvedValue(now),
      getAsset: vi.fn().mockResolvedValue({ ...asset('t'), ownership_status: 'verified' }),
      amendRequest: vi.fn().mockResolvedValue(amended),
      appendAudit: vi.fn().mockResolvedValue({ eventId: 'e9', hash: 'h9' }),
      findRunByRequest: vi.fn().mockResolvedValue(null),
      latestAudit: vi.fn().mockResolvedValue(null),
    };
    return { store, service: new DemoService(store as unknown as DemoStore, 't1') };
  }

  it('amends in place, keeps an account value the browser did not resend, and ledgers gate1.amend without values', async () => {
    const { store, service } = amendService();
    const dto = await service.amendRequest(engineer, 'q1', {
      version: 3,
      objective: 'Look harder.',
      testAccounts: [
        { role: 'Alice', headerName: 'authorization' },
        { role: 'bob', headerName: 'Authorization', headerValue: 'Bearer bob-secret' },
      ],
    });
    expect(store.amendRequest).toHaveBeenCalledWith('t1', 'q1', 3, expect.objectContaining({
      objective: 'Look harder.',
      test_accounts: [
        { role: 'Alice', header_name: 'authorization', header_value: 'Bearer alice-secret' },
        { role: 'bob', header_name: 'Authorization', header_value: 'Bearer bob-secret' },
      ],
      scope: { excludedPaths: ['/setup.php'], releaseProven: 'hold' },
    }));
    const entry = store.appendAudit.mock.calls[0]?.[1] as { action: string; payload: Record<string, unknown> };
    expect(entry.action).toBe('gate1.amend');
    expect(entry.payload).toMatchObject({ version: 4, changed: 'objective,testAccounts', budget: '300 requests, 900 s, $4.00', accounts: 'Alice,bob' });
    expect(JSON.stringify(entry.payload)).not.toContain('secret');
    expect(JSON.stringify(dto)).not.toContain('secret');
    expect(dto.audit).toEqual({ eventId: 'e9', hash: 'h9' });
  });

  it('refuses an account without a value that does not match a saved role and header', async () => {
    const { store, service } = amendService();
    await expect(
      service.amendRequest(engineer, 'q1', { version: 3, testAccounts: [{ role: 'carol', headerName: 'Authorization' }] }),
    ).rejects.toMatchObject({ response: { code: 'account_value_missing', detail: expect.stringContaining('carol') as unknown } });
    await expect(
      service.amendRequest(engineer, 'q1', { version: 3, testAccounts: [{ role: 'alice', headerName: 'Cookie' }] }),
    ).rejects.toMatchObject({ response: { code: 'account_value_missing' } });
    expect(store.amendRequest).not.toHaveBeenCalled();
  });

  it('answers plan_changed for a stale version or a lost race, and request_not_pending once decided', async () => {
    await expect(amendService().service.amendRequest(engineer, 'q1', { version: 2, objective: 'x' })).rejects.toMatchObject({
      response: { code: 'plan_changed' },
    });
    await expect(amendService(null).service.amendRequest(engineer, 'q1', { version: 3, objective: 'x' })).rejects.toMatchObject({
      response: { code: 'plan_changed' },
    });
    const decided = { ...row, status: 'approved' } as RequestRow;
    await expect(amendService(null, decided).service.amendRequest(engineer, 'q1', { version: 3, objective: 'x' })).rejects.toMatchObject({
      response: { code: 'request_not_pending' },
    });
  });

  it('lets only the requester (or an administrator) edit', async () => {
    const other = { ...engineer, id: 'u9' };
    await expect(amendService().service.amendRequest(other, 'q1', { version: 3, objective: 'x' })).rejects.toMatchObject({
      response: { code: 'not_requester' },
    });
    const { store, service } = amendService();
    await service.amendRequest({ ...other, admin: true }, 'q1', { version: 3, objective: 'x' });
    expect(store.amendRequest).toHaveBeenCalled();
  });

  it('validates the body: version required, at least one field', () => {
    expect(amendRequestSchema.safeParse({ objective: 'x' }).success).toBe(false);
    expect(amendRequestSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(amendRequestSchema.safeParse({ version: 1, budgetRequests: 5 }).success).toBe(false);
    expect(amendRequestSchema.safeParse({ version: 1, testAccounts: [{ role: 'a', headerName: 'X-Key' }] }).success).toBe(true);
    expect(amendRequestSchema.safeParse({ version: 1, testAccounts: [{ role: 'a', headerName: 'X' }, { role: 'A', headerName: 'X' }] }).success).toBe(false);
  });
});

describe('clone with untried cases (P1-cov2)', () => {
  const engineer = { id: 'u1', email: 'a@x.test', name: 'A', roles: ['appsec-engineer'] };
  const runId = '0197a5d0-bbbb-7000-8000-000000000001';
  const request = {
    id: 'q1',
    asset_id: 'a1',
    objective: 'Look.',
    scope: {},
    intrusiveness: 'passive',
    test_accounts: [],
    budget_requests: 300,
    budget_seconds: 900,
    cost_cap_usd: '4',
    created_at: new Date(),
  } as unknown as RequestRow;

  function cloneService(cases: unknown[], runRequest = 'q1') {
    const store = {
      getRequest: vi.fn().mockResolvedValue(request),
      getRun: vi.fn().mockResolvedValue({ id: runId, request_id: runRequest }),
      lastEvents: vi.fn().mockResolvedValue([{ seq: 9, kind: 'coverage.summary', data: { cases }, message: '', stage: 'done', at: new Date() }]),
      getAsset: vi.fn().mockResolvedValue({ ...asset('t'), ownership_status: 'verified' }),
      insertRequest: vi.fn(),
      findRunByRequest: vi.fn().mockResolvedValue(null),
      latestAudit: vi.fn().mockResolvedValue(null),
    };
    return { store, service: new DemoService(store as unknown as DemoStore, 't1') };
  }

  it('appends the untried case titles to the objective', async () => {
    const { store, service } = cloneService([
      { id: 'a', title: 'SQL injection in search', status: 'not_run' },
      { id: 'b', title: 'IDOR on baskets', status: 'executed' },
      { id: 'c', title: 'Reflected XSS', status: 'not_run' },
    ]);
    await service.cloneRequest(engineer, 'q1', runId);
    expect(store.insertRequest).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Look.\n\nContinue with the test cases left untried in audit 0197a5d0: SQL injection in search; Reflected XSS',
    }));
  });

  it('refuses when nothing was left untried, or the run belongs to another request', async () => {
    await expect(cloneService([{ id: 'b', title: 'x', status: 'executed' }]).service.cloneRequest(engineer, 'q1', runId)).rejects.toMatchObject({
      response: { code: 'nothing_untried' },
    });
    await expect(cloneService([], 'q2').service.cloneRequest(engineer, 'q1', runId)).rejects.toMatchObject({
      response: { code: 'not_found' },
    });
  });
});

describe('batch Gate 3 (P1-rel1)', () => {
  const engineer = { id: 'u1', email: 'a@x.test', name: 'A', roles: ['appsec-engineer'] };
  const row = (id: string, status: string) =>
    ({ id, run_id: 'r1', title: `T ${id}`, severity: 'high', status, asset_name: 'X', repro_curl: 'curl', owasp_category: 'A01' }) as unknown as FindingRow;

  it('moves what it can, reports conflicts and unknown ids, and ledgers one event per finding moved', async () => {
    const store = {
      getFindings: vi.fn().mockResolvedValue([row('f1', 'confirmed'), row('f2', 'confirmed'), row('f3', 'dismissed')]),
      triageFindings: vi.fn().mockResolvedValue(['f1', 'f2']),
      appendAudits: vi.fn().mockResolvedValue([]),
      appendEvent: vi.fn(),
      recordDelivery: vi.fn(),
    };
    const service = new DemoService(store as unknown as DemoStore, 't1');
    const out = await service.triageMany(engineer, ['f1', 'f2', 'f3', 'f4'], 'release', 'proven, reviewed by hand');
    expect(out).toEqual({
      results: [
        { id: 'f1', ok: true, status: 'released' },
        { id: 'f2', ok: true, status: 'released' },
        { id: 'f3', ok: false, code: 'finding_not_triageable' },
        { id: 'f4', ok: false, code: 'not_found' },
      ],
      moved: 2,
      conflicts: 1,
      failed: 1,
    });
    expect(store.triageFindings).toHaveBeenCalledWith('t1', ['f1', 'f2', 'f3'], ['suspected', 'confirmed'], 'released', 'u1', 'proven, reviewed by hand');
    const entries = store.appendAudits.mock.calls[0]?.[1] as { action: string; targetId: string }[];
    expect(entries.map((e) => [e.action, e.targetId])).toEqual([['finding.release', 'f1'], ['finding.release', 'f2']]);
    expect(store.appendEvent).toHaveBeenCalledTimes(2);
  });

  it('validates the body: 1..200 unique ids', () => {
    const id = '0197a5d0-aaaa-7000-8000-000000000001';
    expect(triageManySchema.safeParse({ decision: 'release', reason: 'long enough', ids: [id] }).success).toBe(true);
    expect(triageManySchema.safeParse({ decision: 'release', reason: 'long enough', ids: [] }).success).toBe(false);
    expect(triageManySchema.safeParse({ decision: 'release', reason: 'long enough', ids: [id, id.toUpperCase()] }).success).toBe(false);
  });
});

describe('DTOs: queue, starter, Gate 2 details, OWASP and read-time scrub', () => {
  const runRow = {
    id: '0197a5d0-aaaa-7000-8000-000000000001',
    state: 'queued',
    created_by: 'u1',
    started_by_name: 'Jatin Singh',
    queue_ahead: 1,
    queue_running: 3,
    created_at: new Date(),
    started_at: null,
    finished_at: null,
    kill_requested_at: null,
    summary: null,
    pins: {},
  } as unknown as RunRow;

  it('shows who started a run and, while queued, where it stands', () => {
    expect(runDto(runRow, 3)).toMatchObject({
      startedBy: { id: 'u1', name: 'Jatin Singh' },
      queue: { position: 2, ahead: 1, running: 3, concurrency: 3 },
    });
    expect(runDto({ ...runRow, state: 'running', queue_ahead: null }, 3).queue).toBeNull();
  });

  it('carries the Gate 2 ask body (scrubbed), role, asset, requester and close reason', () => {
    const dto = gate2Dto(
      {
        id: 'g1',
        run_id: 'r1',
        method: 'POST',
        url: 'http://127.0.0.1:3001/rest/user/login',
        status: 'expired',
        deadline_at: new Date(),
        created_at: new Date(),
        decided_at: null,
        reason: null,
        request_body: '{"email":"a@b.c","password":"hunter2"}',
        as_role: 'alice',
        asset_name: 'Juice Shop',
        requester_id: 'u1',
        requester_name: 'A',
        run_started_at: new Date('2026-11-08T10:00:00Z'),
        close_reason: 'deadline',
      } as unknown as Gate2Row,
      new Date(),
    );
    expect(dto).toMatchObject({
      asRole: 'alice',
      assetName: 'Juice Shop',
      requester: { id: 'u1', name: 'A' },
      runStartedAt: '2026-11-08T10:00:00.000Z',
      closeReason: 'deadline',
    });
    expect(dto.body).not.toContain('hunter2');
  });

  it('normalises OWASP labels and scrubs stored secrets in findings and exchanges', () => {
    expect(owaspLabel('A03:2021-Injection')).toBe('A03:2021 Injection');
    expect(owaspLabel('OWASP A1')).toBe('A01:2021 Broken Access Control');
    expect(owaspLabel('a10')).toBe('A10:2021 Server-Side Request Forgery');
    expect(owaspLabel('API1:2023')).toBe('API1:2023');
    const finding = {
      id: 'f1',
      title: 'Config exposed',
      owasp_category: 'A05',
      description: "$_DVWA[ 'db_password' ] = 'vulnerables';",
      repro_curl: "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln' http://x",
      evidence: { probe: { response: { bodyExcerpt: '{"password":"hunter2"}', bodySha256: 'a'.repeat(64) } } },
      replay: {},
      oracle: {},
      location: {},
      created_at: new Date(),
      triaged_at: null,
      delivered_at: null,
      seen_run_id: 'r0',
      seen_finding_id: 'f0',
      seen_status: 'released',
      seen_at: new Date('2026-11-01T00:00:00Z'),
      identity_key: 'idk',
    } as unknown as FindingRow;
    const dto = JSON.stringify(findingDto(finding));
    expect(dto).not.toContain('vulnerables');
    expect(dto).not.toContain('hunter2');
    expect(dto).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0');
    expect(dto).toContain('a'.repeat(64));
    expect(findingDto(finding)).toMatchObject({
      owasp: 'A05:2021 Security Misconfiguration',
      identityKey: 'idk',
      seenBefore: { runId: 'r0', findingId: 'f0', status: 'released', at: '2026-11-01T00:00:00.000Z' },
    });
    const exchange = exchangeDto({
      id: 'x1',
      seq: 1,
      agent: 'a',
      method: 'GET',
      url: 'http://x/?token=abc123',
      request_headers: { cookie: 'token=abc' },
      request_body: null,
      status: 200,
      response_headers: { 'set-cookie': 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln; Path=/' },
      response_body: '{"password":"hunter2"}',
      duration_ms: 1,
      outcome: 'sent',
      reason: null,
      at: new Date(),
    });
    expect(JSON.stringify(exchange)).not.toMatch(/hunter2|abc123|eyJhbGciOiJIUzI1NiJ9/);
  });
});
