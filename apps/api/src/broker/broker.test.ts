import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BROKER_SCOPES,
  type BrokerScope,
  SUBTASK_LIFECYCLE_STATUSES,
  TEST_CASE_STATUSES,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';
import { createUuidV7Generator } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';

import { loadBrokerConfig } from './config.js';
import {
  InMemoryBrokerAuditSink,
  InMemoryBrokerRunReader,
  InMemoryPdpFactsReader,
} from './memory.js';
import { createBrokerMetrics } from './metrics.js';
import { createSourceGuard, InvalidCidrError } from './network.js';
import { brokerOpenApiDocument } from './openapi.js';
import { createPdpService, type PdpFacts, type PdpService } from './pdp.js';
import { registerBrokerRoutes } from './routes.js';
import {
  createBrokerTokenVerifier,
  InMemoryRunTokenRevocations,
  signBrokerToken,
} from './token.js';
import { killOpenApiDocument } from '../kill/openapi.js';

import type { EngagementPort } from './engagement.js';

const gen = createUuidV7Generator();
const SECRET = 'test-secret-test-secret-test-secret-0123';
const TENANT = gen();
const OTHER_TENANT = gen();
const RUN = gen();
const OTHER_RUN = gen();
const SESSION = gen();
const IDENTITY = 'spiffe://blackwing/ns/sandbox/sa/tool-backend';
const GOOD_IP = '10.20.1.5';
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const BASE = '/internal/broker';

const EVIDENCE = {
  kind: 'log',
  sha256: 'a'.repeat(64),
  sizeBytes: 10,
  contentType: 'text/plain',
};
const TOOL_AUDIT = {
  toolName: 'mcp__engagement__get_engagement_state',
  subtaskId: null,
  testCaseId: null,
  roleId: 'orchestrator',
  durationMs: 12,
  outputBytes: 100,
  outcome: 'success',
  code: null,
  inputSummary: '{}',
};
const CANDIDATE = { title: 'Reflected XSS', vulnClass: 'xss' };
const SUBTASK = gen();
const TEST_CASE = gen();
const DISPATCH = {
  persona: 'auth-logic-specialist',
  subtaskId: SUBTASK,
  testCaseId: TEST_CASE,
  brief: {
    targets: ['https://lab.example.test/login'],
    class: 'passive',
    oracle: { type: 'http_status', params: { status: 200 } },
    negativeControl: { type: 'status_diff', params: {} },
    budget: { maxRequests: 100, maxRps: 5, maxConcurrency: 2, maxBytes: 1_000_000 },
    standardRefs: { wstg: ['WSTG-ATHN-01'], cwe: [], owasp: [] },
  },
};
const zeroCounts = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
const MARK = { testCaseId: TEST_CASE, status: 'executing', reason: 'starting' };
const MENTOR = { subtaskId: SUBTASK, reason: 'stalled for three polls' };
const SCOPE = { target: 'https://other.example.test', reason: 'redirect host' };
const JOURNAL = {
  phase: 'planned',
  intrusiveness: 'passive',
  action: 'noop',
  reversal: 'none',
  targetRef: 'asset-1',
};

interface Ctx {
  app: FastifyInstance;
  runs: InMemoryBrokerRunReader;
  audit: InMemoryBrokerAuditSink;
  revocations: InMemoryRunTokenRevocations;
  metrics: ReturnType<typeof createBrokerMetrics>;
  clock: { now: number };
}

function token(overrides: Partial<Parameters<typeof signBrokerToken>[1]> = {}): string {
  return signBrokerToken(SECRET, {
    tokenId: gen(),
    tenantId: TENANT,
    runId: RUN,
    sessionId: SESSION,
    scopes: [...BROKER_SCOPES],
    issuedAt: NOW_S,
    expiresAt: NOW_S + 600,
    ...overrides,
  });
}

async function build(
  rateLimit = { limit: 1000, windowMs: 60_000 },
  engagement?: EngagementPort,
  pdp?: PdpService,
): Promise<Ctx> {
  const app = Fastify({ logger: false });
  const runs = new InMemoryBrokerRunReader();
  runs.set({ id: RUN, tenantId: TENANT, state: 'executing' });
  runs.set({ id: OTHER_RUN, tenantId: OTHER_TENANT, state: 'executing' });
  const audit = new InMemoryBrokerAuditSink();
  const revocations = new InMemoryRunTokenRevocations();
  const metrics = createBrokerMetrics();
  const clock = { now: NOW_MS };
  registerBrokerRoutes(app, {
    verifier: createBrokerTokenVerifier({ secret: SECRET, now: () => clock.now }),
    revocations,
    sourceGuard: createSourceGuard({
      allowedCidrs: ['10.20.0.0/16', 'fd00:20::/32'],
      identityHeader: 'x-bw-mesh-identity',
      identities: [IDENTITY],
    }),
    runs,
    audit,
    logger: createLogger('api', { level: 'silent' }),
    metrics,
    rateLimit,
    ...(engagement === undefined ? {} : { engagement }),
    ...(pdp === undefined ? {} : { pdp }),
    now: () => clock.now,
    environment: 'test',
  });
  await app.ready();
  return { app, runs, audit, revocations, metrics, clock };
}

interface Call {
  method?: 'GET' | 'POST';
  url?: string;
  auth?: string | null;
  ip?: string;
  identity?: string | null;
  payload?: unknown;
}

function call(ctx: Ctx, c: Call = {}) {
  const headers: Record<string, string> = {};
  const auth = c.auth === undefined ? `Bearer ${token()}` : c.auth;
  if (auth !== null) headers.authorization = auth;
  const identity = c.identity === undefined ? IDENTITY : c.identity;
  if (identity !== null) headers['x-bw-mesh-identity'] = identity;
  return ctx.app.inject({
    method: c.method ?? 'POST',
    url: c.url ?? `${BASE}/runs/${RUN}/candidates`,
    remoteAddress: c.ip ?? GOOD_IP,
    headers,
    ...(c.payload === undefined && (c.method ?? 'POST') === 'POST'
      ? { payload: CANDIDATE }
      : c.payload === undefined
        ? {}
        : { payload: c.payload as object }),
  });
}

describe('Run Broker API', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  describe('authentication (401)', () => {
    it.each([
      ['no Authorization header', null],
      ['a non-bearer scheme', 'Basic abc'],
      ['a bw_pat_ token', 'Bearer bw_pat_abcdef'],
      ['a malformed bwrun_ token', 'Bearer bwrun_nodot'],
      ['a bad signature', `Bearer ${token().slice(0, -3)}AAA`],
    ])('rejects %s with problem+json', async (_name, auth) => {
      const res = await call(ctx, { auth });
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.json<{ code: string }>().code).toBe('UNAUTHENTICATED');
    });

    it('rejects a token signed with another secret', async () => {
      const forged = signBrokerToken('x'.repeat(40), {
        tokenId: gen(),
        tenantId: TENANT,
        runId: RUN,
        sessionId: SESSION,
        scopes: ['candidates:write'],
        issuedAt: NOW_S,
        expiresAt: NOW_S + 60,
      });
      expect((await call(ctx, { auth: `Bearer ${forged}` })).statusCode).toBe(401);
    });

    it('rejects an expired token', async () => {
      const t = token({ issuedAt: NOW_S - 600, expiresAt: NOW_S - 1 });
      expect((await call(ctx, { auth: `Bearer ${t}` })).statusCode).toBe(401);
    });

    it('rejects a token with a lifetime beyond the short-lived maximum', async () => {
      const t = token({ expiresAt: NOW_S + 7200 });
      expect((await call(ctx, { auth: `Bearer ${t}` })).statusCode).toBe(401);
    });

    it('rejects a revoked token and a revoked run immediately', async () => {
      const tokenId = gen();
      ctx.revocations.revokeToken(tokenId);
      expect((await call(ctx, { auth: `Bearer ${token({ tokenId })}` })).statusCode).toBe(401);
      ctx.revocations.revokeRun(RUN);
      expect((await call(ctx)).statusCode).toBe(401);
    });

    it('rejects when revocation lands mid-request, after validation and before acting', async () => {
      const original = ctx.revocations.isRevoked.bind(ctx.revocations);
      let calls = 0;
      ctx.revocations.isRevoked = (input) => {
        calls += 1;
        return calls >= 2 ? true : original(input);
      };
      const res = await call(ctx);
      expect(res.statusCode).toBe(401);
      expect(calls).toBe(2);
    });

    it('does not reveal unknown paths to an unauthenticated caller', async () => {
      const res = await call(ctx, { method: 'GET', url: `${BASE}/nope`, auth: null });
      expect(res.statusCode).toBe(401);
    });

    it('never echoes the token in a response, log label or audit event', async () => {
      const t = token();
      const res = await call(ctx, { auth: `Bearer ${t}` });
      expect(res.body).not.toContain(t);
      expect(JSON.stringify(ctx.audit.events)).not.toContain(t);
      expect(await ctx.metrics.registry.metrics()).not.toContain(t);
    });
  });

  describe('source restriction (fail closed)', () => {
    it('refuses a source outside the allowed CIDRs with 403', async () => {
      const res = await call(ctx, { ip: '192.168.1.9' });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('FORBIDDEN');
    });

    it('refuses when the mesh identity header is missing or wrong, even from an allowed CIDR', async () => {
      expect((await call(ctx, { identity: null })).statusCode).toBe(403);
      expect((await call(ctx, { identity: 'spiffe://evil' })).statusCode).toBe(403);
    });

    it('ignores a spoofed X-Forwarded-For and a spoofed identity from a bad source', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `${BASE}/runs/${RUN}/candidates`,
        remoteAddress: '203.0.113.7',
        headers: {
          authorization: `Bearer ${token()}`,
          'x-forwarded-for': GOOD_IP,
          'x-bw-mesh-identity': IDENTITY,
        },
        payload: CANDIDATE,
      });
      expect(res.statusCode).toBe(403);
    });

    it('checks the source before the token, so a bad source with a good token is 403', async () => {
      expect((await call(ctx, { ip: '8.8.8.8' })).statusCode).toBe(403);
      expect((await call(ctx, { ip: '8.8.8.8', auth: null })).statusCode).toBe(403);
    });

    it('accepts an IPv4-mapped IPv6 spelling of an allowed address and an allowed IPv6 CIDR', async () => {
      expect((await call(ctx, { ip: `::ffff:${GOOD_IP}` })).statusCode).toBe(501);
      expect((await call(ctx, { ip: 'fd00:20::7' })).statusCode).toBe(501);
    });

    it('refuses everything when the policy is empty or incomplete', () => {
      const headers = { 'x-bw-mesh-identity': IDENTITY };
      const empty = createSourceGuard({
        allowedCidrs: [],
        identityHeader: 'x-bw-mesh-identity',
        identities: [IDENTITY],
      });
      expect(empty.check({ remoteAddress: GOOD_IP, headers })).toBe('no_policy');
      const noIdentity = createSourceGuard({
        allowedCidrs: ['10.0.0.0/8'],
        identityHeader: 'x-bw-mesh-identity',
        identities: [],
      });
      expect(noIdentity.check({ remoteAddress: GOOD_IP, headers })).toBe('no_policy');
      const guard = createSourceGuard({
        allowedCidrs: ['10.0.0.0/8'],
        identityHeader: 'x-bw-mesh-identity',
        identities: [IDENTITY],
      });
      expect(guard.check({ remoteAddress: undefined, headers })).toBe('no_address');
      expect(guard.check({ remoteAddress: 'not-an-ip', headers })).toBe('bad_address');
    });

    it('refuses to start on a malformed CIDR', () => {
      for (const bad of ['10.0.0.0/33', 'nope', '10.0.0.0/8/8', '::1/129', '10.0.0.0/x']) {
        expect(() =>
          createSourceGuard({ allowedCidrs: [bad], identityHeader: 'x', identities: ['a'] }),
        ).toThrow(InvalidCidrError);
      }
    });
  });

  describe('run binding (403)', () => {
    it('rejects a path run id that differs from the token run id', async () => {
      const res = await call(ctx, { url: `${BASE}/runs/${OTHER_RUN}/candidates` });
      expect(res.statusCode).toBe(403);
    });

    it('answers a foreign run and a nonexistent run identically (no existence leak)', async () => {
      const a = await call(ctx, { url: `${BASE}/runs/${OTHER_RUN}/candidates` });
      const b = await call(ctx, { url: `${BASE}/runs/${gen()}/candidates` });
      const c = await call(ctx, { url: `${BASE}/runs/not-a-uuid/candidates` });
      for (const res of [a, b, c]) expect(res.statusCode).toBe(403);
      const strip = (r: typeof a) => ({ ...r.json<Record<string, unknown>>(), traceId: '' });
      expect(strip(a)).toEqual(strip(b));
      expect(strip(a)).toEqual(strip(c));
    });

    it('rejects a body run id or tenant id that differs from the token', async () => {
      const wrongRun = await call(ctx, { payload: { ...CANDIDATE, runId: OTHER_RUN } });
      const wrongTenant = await call(ctx, { payload: { ...CANDIDATE, tenantId: OTHER_TENANT } });
      expect(wrongRun.statusCode).toBe(403);
      expect(wrongTenant.statusCode).toBe(403);
      const matching = await call(ctx, { payload: { ...CANDIDATE, runId: RUN, tenantId: TENANT } });
      expect(matching.statusCode).toBe(501);
    });

    it('rejects a token whose run belongs to another tenant than the run record (RLS stand-in)', async () => {
      // The token claims OTHER_RUN under TENANT; the tenant-scoped reader cannot see OTHER_TENANT's run.
      const t = token({ runId: OTHER_RUN });
      const res = await call(ctx, {
        auth: `Bearer ${t}`,
        url: `${BASE}/runs/${OTHER_RUN}/state`,
        method: 'GET',
      });
      expect(res.statusCode).toBe(403);
    });

    it('answers CROSS_TENANT_DENIED and audits when the body names another tenant', async () => {
      const res = await call(ctx, { payload: { ...CANDIDATE, tenantId: OTHER_TENANT } });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('CROSS_TENANT_DENIED');
      expect(res.body).not.toContain(OTHER_TENANT);
      const event = ctx.audit.events.find((e) => e.action === 'tenant.cross_tenant_denied');
      expect(event?.tenantId).toBe(TENANT);
      expect(event?.runId).toBe(RUN);
      const metric = await ctx.metrics.registry.getSingleMetricAsString(
        'bw_cross_tenant_denied_total',
      );
      expect(metric).toContain('bw_cross_tenant_denied_total 1');
    });

    it('answers CROSS_TENANT_DENIED when the reader returns a run of another tenant', async () => {
      ctx.runs.getRun = () =>
        Promise.resolve({ id: RUN, tenantId: OTHER_TENANT, state: 'executing' });
      const res = await call(ctx, { method: 'GET', url: `${BASE}/runs/${RUN}/state` });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('CROSS_TENANT_DENIED');
      expect(ctx.audit.events.some((e) => e.action === 'tenant.cross_tenant_denied')).toBe(true);
    });

    it('rejects an endpoint whose scope the token does not carry', async () => {
      const t = token({ scopes: ['state:read'] });
      expect((await call(ctx, { auth: `Bearer ${t}` })).statusCode).toBe(403);
      const ok = await call(ctx, {
        auth: `Bearer ${t}`,
        method: 'GET',
        url: `${BASE}/runs/${RUN}/state`,
      });
      expect(ok.statusCode).toBe(501);
    });
  });

  describe('stub endpoints (501 not_implemented)', () => {
    const cases: [string, 'GET' | 'POST', string, unknown, BrokerScope][] = [
      ['candidates', 'POST', 'candidates', CANDIDATE, 'candidates:write'],
      ['evidence', 'POST', 'evidence', EVIDENCE, 'evidence:write'],
      ['journal', 'POST', 'journal', JOURNAL, 'journal:write'],
      ['tool-audit', 'POST', 'tool-audit', TOOL_AUDIT, 'audit:write'],
      ['state', 'GET', 'state', undefined, 'state:read'],
      ['engagement state', 'GET', 'engagement/state', undefined, 'engagement:read'],
      ['engagement open subtasks', 'GET', 'engagement/subtasks/open', undefined, 'engagement:read'],
      ['engagement dispatch', 'POST', 'engagement/dispatch', DISPATCH, 'engagement:write'],
      [
        'engagement subtask result',
        'GET',
        `engagement/subtasks/${SUBTASK}/result`,
        undefined,
        'engagement:read',
      ],
      [
        'engagement test case status',
        'POST',
        'engagement/test-cases/status',
        MARK,
        'engagement:write',
      ],
      ['engagement mentor review', 'POST', 'engagement/mentor-reviews', MENTOR, 'engagement:write'],
      [
        'engagement scope exception',
        'POST',
        'engagement/scope-exceptions',
        SCOPE,
        'engagement:write',
      ],
    ];

    it.each(cases)(
      '%s validates and answers 501 problem+json',
      async (_n, method, path, payload) => {
        const res = await call(ctx, { method, url: `${BASE}/runs/${RUN}/${path}`, payload });
        expect(res.statusCode).toBe(501);
        expect(res.headers['content-type']).toContain('application/problem+json');
        const body = res.json<{ code: string; status: number; traceId: string }>();
        expect(body.code).toBe('NOT_IMPLEMENTED');
        expect(body.status).toBe(501);
        expect(body.traceId).toMatch(/^[0-9a-f]{32}$/);
      },
    );

    it.each(cases.filter((c) => c[1] === 'POST'))(
      '%s rejects an invalid body with 422',
      async (_n, _m, path) => {
        const res = await call(ctx, {
          url: `${BASE}/runs/${RUN}/${path}`,
          payload: { bogus: true },
        });
        expect(res.statusCode).toBe(422);
        expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
      },
    );

    it('rejects unknown extra fields and an oversized evidence digest', async () => {
      const extra = await call(ctx, { payload: { ...CANDIDATE, extra: 1 } });
      expect(extra.statusCode).toBe(422);
      const badDigest = await call(ctx, {
        url: `${BASE}/runs/${RUN}/evidence`,
        payload: { ...EVIDENCE, sha256: 'xyz' },
      });
      expect(badDigest.statusCode).toBe(422);
    });

    it('rejects malformed JSON as a 4xx problem, not a 500', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `${BASE}/runs/${RUN}/candidates`,
        remoteAddress: GOOD_IP,
        headers: {
          authorization: `Bearer ${token()}`,
          'x-bw-mesh-identity': IDENTITY,
          'content-type': 'application/json',
        },
        payload: '{not json',
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it('answers unknown paths with 404 only to an authenticated caller', async () => {
      const res = await call(ctx, { method: 'GET', url: `${BASE}/runs/${RUN}/nothing` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('engagement endpoints (MCP-012)', () => {
    interface Calls {
      readonly calls: { name: string; args: unknown[] }[];
    }
    function wiredPort(overrides: Partial<EngagementPort> = {}): EngagementPort & Calls {
      const calls: Calls['calls'] = [];
      const record =
        <A extends unknown[], R>(name: string, value: (...args: A) => R) =>
        (...args: A): R => {
          calls.push({ name, args });
          return value(...args);
        };
      return {
        calls,
        state: record('state', () =>
          Promise.resolve({
            runId: RUN,
            phase: 'executing',
            testCases: zeroCounts(TEST_CASE_STATUSES),
            subtasks: zeroCounts(SUBTASK_LIFECYCLE_STATUSES),
            confirmedFindings: 0,
          }),
        ),
        openSubtasks: record('openSubtasks', () => Promise.resolve({ items: [] })),
        dispatch: record('dispatch', () =>
          Promise.resolve({
            accepted: true,
            subtaskId: SUBTASK,
            status: 'dispatched',
            created: true,
          }),
        ),
        subtaskResult: record('subtaskResult', () =>
          Promise.resolve({ subtaskId: SUBTASK, status: 'running', pending: true, result: null }),
        ),
        markTestCase: record('markTestCase', () =>
          Promise.resolve({
            testCaseId: TEST_CASE,
            status: 'executing',
            previousStatus: 'approved',
          }),
        ),
        requestMentorReview: record('requestMentorReview', () =>
          Promise.resolve({ reviewId: gen(), status: 'requested' as const }),
        ),
        requestScopeException: record('requestScopeException', () =>
          Promise.resolve({ decisionId: gen(), gate: 2 as const, status: 'pending' as const }),
        ),
        ...overrides,
      };
    }

    it('answers a wired read from the port with the token run and records a success', async () => {
      const port = wiredPort();
      const wired = await build(undefined, port);
      try {
        const res = await call(wired, {
          method: 'GET',
          url: `${BASE}/runs/${RUN}/engagement/state`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json<{ phase: string }>().phase).toBe('executing');
        expect(port.calls[0]?.args[0]).toEqual({ tenantId: TENANT, runId: RUN });
        expect(wired.audit.events.at(-1)).toMatchObject({
          action: 'broker.engagement.state_read',
          outcome: 'success',
        });
      } finally {
        await wired.app.close();
      }
    });

    it('dispatches through the port with the run from the token and returns the Run Controller outcome', async () => {
      const port = wiredPort();
      const wired = await build(undefined, port);
      try {
        const res = await call(wired, {
          url: `${BASE}/runs/${RUN}/engagement/dispatch`,
          payload: DISPATCH,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json<{ accepted: boolean }>().accepted).toBe(true);
        const [ref, body] = port.calls[0]?.args ?? [];
        expect(ref).toEqual({ tenantId: TENANT, runId: RUN });
        expect(body).toEqual(DISPATCH);
      } finally {
        await wired.app.close();
      }
    });

    it('refuses a dispatch whose brief is oversized before the port is reached', async () => {
      const port = wiredPort();
      const wired = await build(undefined, port);
      try {
        const huge = {
          ...DISPATCH,
          brief: {
            ...DISPATCH.brief,
            targets: Array.from({ length: 100 }, () => `https://x.example.test/${'a'.repeat(200)}`),
          },
        };
        const res = await call(wired, {
          url: `${BASE}/runs/${RUN}/engagement/dispatch`,
          payload: huge,
        });
        expect(res.statusCode).toBe(422);
        expect(port.calls).toHaveLength(0);
      } finally {
        await wired.app.close();
      }
    });

    it('maps an invalid test-case transition from the port to 409 INVALID_TRANSITION', async () => {
      const wired = await build(
        undefined,
        wiredPort({
          markTestCase: () => Promise.reject(new AppError('INVALID_TRANSITION', 'nope')),
        }),
      );
      try {
        const res = await call(wired, {
          url: `${BASE}/runs/${RUN}/engagement/test-cases/status`,
          payload: MARK,
        });
        expect(res.statusCode).toBe(409);
        expect(res.json<{ code: string }>().code).toBe('INVALID_TRANSITION');
      } finally {
        await wired.app.close();
      }
    });

    it('rejects a malformed subtask id in the result path before the port is reached', async () => {
      const port = wiredPort();
      const wired = await build(undefined, port);
      try {
        const res = await call(wired, {
          method: 'GET',
          url: `${BASE}/runs/${RUN}/engagement/subtasks/not-a-uuid/result`,
        });
        expect(res.statusCode).toBe(422);
        expect(port.calls).toHaveLength(0);
      } finally {
        await wired.app.close();
      }
    });

    it('answers an unknown subtask result with 404 and never reveals another run', async () => {
      const wired = await build(
        undefined,
        wiredPort({ subtaskResult: () => Promise.resolve(null) }),
      );
      try {
        const res = await call(wired, {
          method: 'GET',
          url: `${BASE}/runs/${RUN}/engagement/subtasks/${gen()}/result`,
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await wired.app.close();
      }
    });

    it('refuses a write once the run is terminal, before the port is reached', async () => {
      const port = wiredPort();
      const wired = await build(undefined, port);
      try {
        wired.runs.set({ id: RUN, tenantId: TENANT, state: 'completed' });
        const res = await call(wired, {
          url: `${BASE}/runs/${RUN}/engagement/scope-exceptions`,
          payload: SCOPE,
        });
        expect(res.statusCode).toBe(409);
        expect(res.json<{ code: string }>().code).toBe('RUN_NOT_ACTIVE');
        expect(port.calls).toHaveLength(0);
      } finally {
        await wired.app.close();
      }
    });

    it('refuses an engagement write whose scope the token does not carry', async () => {
      const port = wiredPort();
      const wired = await build(undefined, port);
      try {
        const readOnly = token({ scopes: ['engagement:read'] });
        const res = await call(wired, {
          url: `${BASE}/runs/${RUN}/engagement/dispatch`,
          payload: DISPATCH,
          auth: `Bearer ${readOnly}`,
        });
        expect(res.statusCode).toBe(403);
        expect(port.calls).toHaveLength(0);
      } finally {
        await wired.app.close();
      }
    });
  });

  describe('PDP evaluate (RUNTIME-005)', () => {
    const PDP_URL = `${BASE}/runs/${RUN}/pdp/evaluate`;
    const PDP_BODY = {
      toolName: 'Bash',
      toolUseId: 'toolu_1',
      targets: ['https://lab.example.test/login'],
      subtaskId: SUBTASK,
      testCaseId: TEST_CASE,
      roleId: 'auth-specialist',
    };
    const facts = (overrides: Partial<PdpFacts> = {}): PdpFacts => ({
      envelope: {
        validFrom: new Date(NOW_MS - 1000),
        expiresAt: new Date(NOW_MS + 60_000),
        revoked: false,
        maxIntrusiveness: 'active_safe',
      },
      sessionCeiling: 'active_safe',
      testCaseClass: 'active_safe',
      reversalJournalPresent: false,
      inScope: (target) => target === 'https://lab.example.test/login',
      ...overrides,
    });
    const wired = async (pdpFacts: PdpFacts = facts()): Promise<Ctx> => {
      const reader = new InMemoryPdpFactsReader();
      reader.set({ tenantId: TENANT, runId: RUN }, pdpFacts);
      const pdp = createPdpService({ facts: reader, now: () => new Date(NOW_MS) });
      return build(undefined, undefined, pdp);
    };

    it('answers 501 and denies (fail closed) while no PDP is wired', async () => {
      ctx = await build();
      const res = await call(ctx, { url: PDP_URL, payload: PDP_BODY });
      expect(res.statusCode).toBe(501);
      expect(res.json<{ code: string }>().code).toBe('NOT_IMPLEMENTED');
      expect(ctx.audit.events.at(-1)?.outcome).toBe('not_implemented');
      expect(ctx.audit.events.at(-1)?.decision).toBeUndefined();
    });

    it('returns allow for an in-envelope call and audits the decision', async () => {
      ctx = await wired();
      const res = await call(ctx, { url: PDP_URL, payload: PDP_BODY });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ decision: 'allow', reason: 'in_envelope' });
      const event = ctx.audit.events.at(-1);
      expect(event).toMatchObject({
        action: 'broker.pdp.evaluate',
        outcome: 'success',
        decision: 'allow',
        reason: 'in_envelope',
        runId: RUN,
        tenantId: TENANT,
      });
    });

    it('returns deny with the reason for an out-of-scope target and audits it', async () => {
      ctx = await wired();
      const res = await call(ctx, {
        url: PDP_URL,
        payload: { ...PDP_BODY, targets: ['https://other.example.test/'] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ decision: 'deny', reason: 'out_of_scope' });
      expect(ctx.audit.events.at(-1)).toMatchObject({ decision: 'deny', reason: 'out_of_scope' });
    });

    it('denies a state_changing test case without its journal entry', async () => {
      ctx = await wired(
        facts({
          envelope: {
            validFrom: new Date(NOW_MS - 1000),
            expiresAt: new Date(NOW_MS + 60_000),
            revoked: false,
            maxIntrusiveness: 'state_changing',
          },
          sessionCeiling: 'state_changing',
          testCaseClass: 'state_changing',
        }),
      );
      const res = await call(ctx, { url: PDP_URL, payload: PDP_BODY });
      expect(res.json()).toEqual({ decision: 'deny', reason: 'state_change_without_journal' });
    });

    it('denies an unknown run as no envelope, without revealing the run', async () => {
      ctx = await build(
        undefined,
        undefined,
        createPdpService({
          facts: new InMemoryPdpFactsReader(),
          now: () => new Date(NOW_MS),
        }),
      );
      const res = await call(ctx, { url: PDP_URL, payload: PDP_BODY });
      expect(res.json()).toEqual({ decision: 'deny', reason: 'no_envelope' });
    });

    it('refuses a token without the pdp:evaluate scope with 403 and no decision', async () => {
      ctx = await wired();
      const scopes = BROKER_SCOPES.filter((scope) => scope !== 'pdp:evaluate');
      const res = await call(ctx, {
        url: PDP_URL,
        payload: PDP_BODY,
        auth: `Bearer ${token({ scopes: [...scopes] })}`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('FORBIDDEN');
    });

    it.each([
      ['an unknown field', { ...PDP_BODY, input: { command: 'id' } }],
      ['a non-uuid subtask', { ...PDP_BODY, subtaskId: 'nope' }],
      [
        'more targets than allowed',
        { ...PDP_BODY, targets: Array.from({ length: 17 }, () => 'a.test') },
      ],
      ['an empty tool name', { ...PDP_BODY, toolName: '' }],
    ])('rejects a malformed body (%s) with 422 and no decision', async (_name, payload) => {
      ctx = await wired();
      const res = await call(ctx, { url: PDP_URL, payload });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ decision?: string }>().decision).toBeUndefined();
    });

    it('refuses a body that names another run with 403', async () => {
      ctx = await wired();
      const res = await call(ctx, { url: PDP_URL, payload: { ...PDP_BODY, runId: OTHER_RUN } });
      expect(res.statusCode).toBe(403);
    });

    it('fails closed with a 500 when the facts cannot be loaded', async () => {
      ctx = await build(undefined, undefined, {
        evaluate: () => Promise.reject(new Error('database down')),
      });
      const res = await call(ctx, { url: PDP_URL, payload: PDP_BODY });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('database down');
      expect(ctx.audit.events.at(-1)?.outcome).toBe('error');
    });
  });

  describe('run state', () => {
    it.each(['completed', 'cancelled', 'killed', 'failed', 'expired'] as const)(
      'rejects broker writes for a %s run with 409 run_not_active',
      async (state) => {
        ctx.runs.set({ id: RUN, tenantId: TENANT, state });
        for (const [path, payload] of [
          ['candidates', CANDIDATE],
          ['evidence', EVIDENCE],
          ['journal', JOURNAL],
          ['tool-audit', TOOL_AUDIT],
        ] as const) {
          const res = await call(ctx, { url: `${BASE}/runs/${RUN}/${path}`, payload });
          expect(res.statusCode).toBe(409);
          expect(res.json<{ code: string }>().code).toBe('RUN_NOT_ACTIVE');
        }
      },
    );

    it('still lets a terminal run be read (state is a read, answered 501 by the stub)', async () => {
      ctx.runs.set({ id: RUN, tenantId: TENANT, state: 'killed' });
      const res = await call(ctx, { method: 'GET', url: `${BASE}/runs/${RUN}/state` });
      expect(res.statusCode).toBe(501);
    });
  });

  describe('rate limiting by run token', () => {
    it('answers 429 with Retry-After once a run session exceeds the limit, and recovers next window', async () => {
      await ctx.app.close();
      ctx = await build({ limit: 2, windowMs: 60_000 });
      expect((await call(ctx)).statusCode).toBe(501);
      expect((await call(ctx)).statusCode).toBe(501);
      const limited = await call(ctx);
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // another session is unaffected
      const other = token({ sessionId: gen() });
      expect((await call(ctx, { auth: `Bearer ${other}` })).statusCode).toBe(501);
      ctx.clock.now += 61_000;
      expect(
        (
          await call(ctx, {
            auth: `Bearer ${token({ issuedAt: NOW_S + 61, expiresAt: NOW_S + 661 })}`,
          })
        ).statusCode,
      ).toBe(501);
    });
  });

  describe('audit and metrics', () => {
    it('audits every broker action with ids only, including denials', async () => {
      await call(ctx);
      await call(ctx, { url: `${BASE}/runs/${OTHER_RUN}/candidates` });
      await call(ctx, { payload: { bogus: 1 } });
      expect(ctx.audit.events.map((e) => e.outcome)).toEqual([
        'not_implemented',
        'denied',
        'rejected',
      ]);
      const first = ctx.audit.events[0];
      expect(first).toMatchObject({
        action: 'broker.candidate.submit',
        tenantId: TENANT,
        runId: RUN,
        sessionId: SESSION,
        status: 501,
      });
    });

    it('does not change the response when the audit sink fails', async () => {
      ctx.audit.record = () => {
        throw new Error('ledger down');
      };
      expect((await call(ctx)).statusCode).toBe(501);
      expect(await ctx.metrics.registry.metrics()).toContain('broker_audit_failures_total');
    });

    it('counts requests by route pattern and status, and auth failures by reason', async () => {
      await call(ctx);
      await call(ctx, { auth: null });
      await call(ctx, { ip: '8.8.8.8' });
      const text = await ctx.metrics.registry.metrics();
      expect(text).toContain(
        `broker_requests_total{endpoint="${BASE}/runs/:runId/candidates",status="501"} 1`,
      );
      expect(text).toContain('broker_auth_failures_total{reason="missing"} 1');
      expect(text).toContain('broker_auth_failures_total{reason="source_cidr_mismatch"} 1');
    });
  });
});

describe('broker configuration', () => {
  it('refuses a short secret and treats empty lists as none (fail closed)', () => {
    expect(() => loadBrokerConfig({ BROKER_RUN_TOKEN_SECRET: 'short' })).toThrow();
    const config = loadBrokerConfig({ BROKER_RUN_TOKEN_SECRET: SECRET });
    expect(config.BROKER_ALLOWED_CIDRS).toEqual([]);
    expect(config.BROKER_MESH_IDENTITIES).toEqual([]);
    const parsed = loadBrokerConfig({
      BROKER_RUN_TOKEN_SECRET: SECRET,
      BROKER_ALLOWED_CIDRS: '10.0.0.0/8, fd00::/8',
      BROKER_MESH_IDENTITIES: 'a,b',
    });
    expect(parsed.BROKER_ALLOWED_CIDRS).toEqual(['10.0.0.0/8', 'fd00::/8']);
  });
});

describe('public OpenAPI exclusion', () => {
  it('keeps /internal/broker out of the public document and every public path under /v1', () => {
    const publicPaths = Object.keys(
      (killOpenApiDocument() as { paths: Record<string, unknown> }).paths,
    );
    expect(publicPaths.length).toBeGreaterThan(0);
    for (const path of publicPaths) {
      expect(path.startsWith('/v1/')).toBe(true);
      expect(path).not.toContain('/internal/broker');
    }
  });

  it('describes the broker in its own internal document only', () => {
    const doc = brokerOpenApiDocument() as {
      paths: Record<string, unknown>;
      info: { title: string };
    };
    expect(Object.keys(doc.paths).sort()).toEqual([
      `${BASE}/runs/{runId}/candidates`,
      `${BASE}/runs/{runId}/engagement/dispatch`,
      `${BASE}/runs/{runId}/engagement/mentor-reviews`,
      `${BASE}/runs/{runId}/engagement/scope-exceptions`,
      `${BASE}/runs/{runId}/engagement/state`,
      `${BASE}/runs/{runId}/engagement/subtasks/open`,
      `${BASE}/runs/{runId}/engagement/subtasks/{subtaskId}/result`,
      `${BASE}/runs/{runId}/engagement/test-cases/status`,
      `${BASE}/runs/{runId}/evidence`,
      `${BASE}/runs/{runId}/journal`,
      `${BASE}/runs/{runId}/pdp/evaluate`,
      `${BASE}/runs/{runId}/state`,
      `${BASE}/runs/{runId}/tool-audit`,
    ]);
    expect(doc.info.title).toContain('internal');
  });
});
