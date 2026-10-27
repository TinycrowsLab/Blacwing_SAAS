import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BROKER_SCOPES, type BrokerScope } from '@blackwing/contracts';
import { createUuidV7Generator } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';

import { loadBrokerConfig } from './config.js';
import { InMemoryBrokerAuditSink, InMemoryBrokerRunReader } from './memory.js';
import { createBrokerMetrics } from './metrics.js';
import { createSourceGuard, InvalidCidrError } from './network.js';
import { brokerOpenApiDocument } from './openapi.js';
import { registerBrokerRoutes } from './routes.js';
import {
  createBrokerTokenVerifier,
  InMemoryRunTokenRevocations,
  signBrokerToken,
} from './token.js';
import { killOpenApiDocument } from '../kill/openapi.js';

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

async function build(rateLimit = { limit: 1000, windowMs: 60_000 }): Promise<Ctx> {
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
      `${BASE}/runs/{runId}/evidence`,
      `${BASE}/runs/{runId}/journal`,
      `${BASE}/runs/{runId}/state`,
      `${BASE}/runs/{runId}/tool-audit`,
    ]);
    expect(doc.info.title).toContain('internal');
  });
});
