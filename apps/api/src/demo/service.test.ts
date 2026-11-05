// DEMO-STORY unit tests: the pure rules of the demo API (no database): roles, origins, kill confirmation,
// the Gate 2 countdown and the ownership proof.
import { describe, expect, it, vi } from 'vitest';

import { gate2DecisionSchema } from './controller.js';
import { ALL_ROLES, DemoRefusal, DemoService, actorHasRole, originsOf, secondsLeft, shortId } from './service.js';

import type { AssetRow, DemoStore, FindingRow, RequestRow } from './store.js';

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
  };
  const fetchImpl = vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));
  return { store, service: new DemoService(store as unknown as DemoStore, 't1', fetchImpl) };
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
    const service = new DemoService(store as unknown as DemoStore, 't1');
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

  function service(extra: Record<string, unknown> = {}) {
    const store = {
      getRequest: vi.fn().mockResolvedValue(requestRow('pending_gate1')),
      decideRequest: vi.fn().mockResolvedValue(true),
      findRunByRequest: vi.fn().mockResolvedValue(null),
      appendAudit: vi.fn().mockResolvedValue({ eventId: 'e1', hash: 'h1' }),
      ...extra,
    };
    return { store, service: new DemoService(store as unknown as DemoStore, 't1') };
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
