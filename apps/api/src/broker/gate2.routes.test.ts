import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BROKER_SCOPES, type BrokerScope } from '@blackwing/contracts';
import { createUuidV7Generator } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';

import { InMemoryBrokerAuditSink, InMemoryBrokerRunReader } from './memory.js';
import { createBrokerMetrics } from './metrics.js';
import { createSourceGuard } from './network.js';
import { BROKER_GATE2_EXCEPTIONS_ROUTE, registerBrokerRoutes } from './routes.js';
import {
  createBrokerTokenVerifier,
  InMemoryRunTokenRevocations,
  signBrokerToken,
} from './token.js';

import type { Gate2ExceptionPort } from './gate2.js';

const gen = createUuidV7Generator();
const SECRET = 'test-secret-test-secret-test-secret-0123';
const TENANT = gen();
const OTHER_TENANT = gen();
const RUN = gen();
const SESSION = gen();
const IDENTITY = 'spiffe://blackwing/ns/sandbox/sa/tool-backend';
const GOOD_IP = '10.20.1.5';
const NOW_S = 1_800_000_000;
const URL = BROKER_GATE2_EXCEPTIONS_ROUTE.replace('/internal/broker', '');
const PATH = '/internal/broker/gate2/exceptions';
const KEY = 'hook-call-0001';
const EXCEPTION_ID = gen();

const BODY = {
  sessionId: SESSION,
  toolName: 'nmap.scan',
  proposedActionSummary: '{"target":"10.0.0.9"}',
  envelopeReason: 'target outside the approved envelope',
  intrusiveness: 'active_safe',
};

interface Ctx {
  app: FastifyInstance;
  runs: InMemoryBrokerRunReader;
  port: { raise: ReturnType<typeof vi.fn> };
}

function token(
  scopes: readonly BrokerScope[] = [...BROKER_SCOPES],
  runId = RUN,
  tenantId = TENANT,
) {
  return signBrokerToken(SECRET, {
    tokenId: gen(),
    tenantId,
    runId,
    sessionId: SESSION,
    scopes: [...scopes],
    issuedAt: NOW_S,
    expiresAt: NOW_S + 600,
  });
}

async function build(port: Gate2ExceptionPort | undefined): Promise<Ctx> {
  const app = Fastify({ logger: false });
  const runs = new InMemoryBrokerRunReader();
  runs.set({ id: RUN, tenantId: TENANT, state: 'executing' });
  const raise = vi.fn(() =>
    Promise.resolve({ exceptionId: EXCEPTION_ID, state: 'pending' as const }),
  );
  registerBrokerRoutes(app, {
    verifier: createBrokerTokenVerifier({ secret: SECRET, now: () => NOW_S * 1000 }),
    revocations: new InMemoryRunTokenRevocations(),
    sourceGuard: createSourceGuard({
      allowedCidrs: ['10.20.0.0/16'],
      identityHeader: 'x-bw-mesh-identity',
      identities: [IDENTITY],
    }),
    runs,
    audit: new InMemoryBrokerAuditSink(),
    logger: createLogger('api', { level: 'silent' }),
    metrics: createBrokerMetrics(),
    rateLimit: { limit: 1000, windowMs: 60_000 },
    ...(port === undefined ? {} : { gate2: { raise } satisfies Gate2ExceptionPort }),
    now: () => NOW_S * 1000,
    environment: 'test',
  });
  await app.ready();
  return { app, runs, port: { raise } };
}

function post(
  ctx: Ctx,
  opts: {
    auth?: string | null;
    key?: string | null;
    payload?: unknown;
    url?: string;
  } = {},
) {
  const headers: Record<string, string> = { 'x-bw-mesh-identity': IDENTITY };
  const auth = opts.auth === undefined ? `Bearer ${token()}` : opts.auth;
  if (auth !== null) headers.authorization = auth;
  const key = opts.key === undefined ? KEY : opts.key;
  if (key !== null) headers['idempotency-key'] = key;
  return ctx.app.inject({
    method: 'POST',
    url: opts.url ?? PATH,
    remoteAddress: GOOD_IP,
    headers,
    payload: opts.payload ?? BODY,
  });
}

describe('POST /internal/broker/gate2/exceptions', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build({ raise: vi.fn() });
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('is the route the path names, without a run segment', () => {
    expect(URL).toBe('/gate2/exceptions');
  });

  it('passes the token-bound run and session and the key to the port, and answers its state', async () => {
    const res = await post(ctx);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exceptionId: EXCEPTION_ID, state: 'pending' });
    expect(ctx.port.raise).toHaveBeenCalledTimes(1);
    expect(ctx.port.raise).toHaveBeenCalledWith({
      ref: { tenantId: TENANT, runId: RUN, sessionId: SESSION },
      body: expect.objectContaining({ toolName: 'nmap.scan', batch: false }) as unknown,
      idempotencyKey: KEY,
    });
  });

  it('refuses a request without an Idempotency-Key header before the port runs', async () => {
    const res = await post(ctx, { key: null });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(ctx.port.raise).not.toHaveBeenCalled();
  });

  it('refuses a request without a run token (401) and never reaches the port', async () => {
    const res = await post(ctx, { auth: null });
    expect(res.statusCode).toBe(401);
    expect(ctx.port.raise).not.toHaveBeenCalled();
  });

  it('refuses a token that lacks gate2:write (403)', async () => {
    const scoped = [...BROKER_SCOPES].filter((s) => s !== 'gate2:write') as BrokerScope[];
    const res = await post(ctx, { auth: `Bearer ${token(scoped)}` });
    expect(res.statusCode).toBe(403);
    expect(ctx.port.raise).not.toHaveBeenCalled();
  });

  it('refuses a cross-tenant token: its run is not the tenant run, so 403 and no port call', async () => {
    const res = await post(ctx, { auth: `Bearer ${token([...BROKER_SCOPES], RUN, OTHER_TENANT)}` });
    expect(res.statusCode).toBe(403);
    expect(ctx.port.raise).not.toHaveBeenCalled();
  });

  it('refuses a body that names another run than the token (403 run mismatch)', async () => {
    const res = await post(ctx, { payload: { ...BODY, runId: gen() } });
    expect(res.statusCode).toBe(403);
    expect(ctx.port.raise).not.toHaveBeenCalled();
  });

  it('refuses an unknown body field (strict body, 422)', async () => {
    const res = await post(ctx, { payload: { ...BODY, tenantId: TENANT } });
    expect(res.statusCode).toBe(422);
    expect(ctx.port.raise).not.toHaveBeenCalled();
  });

  it('refuses an invalid intrusiveness class before the port runs', async () => {
    const res = await post(ctx, { payload: { ...BODY, intrusiveness: 'yolo' } });
    expect(res.statusCode).toBe(422);
    expect(ctx.port.raise).not.toHaveBeenCalled();
  });

  it('refuses a summary above the input limit (422) rather than storing it', async () => {
    const res = await post(ctx, {
      payload: { ...BODY, proposedActionSummary: 'x'.repeat(65_537) },
    });
    expect(res.statusCode).toBe(422);
    expect(ctx.port.raise).not.toHaveBeenCalled();
  });

  it('answers RUN_NOT_ACTIVE (409) for a killed run and writes nothing', async () => {
    ctx.runs.set({ id: RUN, tenantId: TENANT, state: 'killed' });
    const res = await post(ctx);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('RUN_NOT_ACTIVE');
    expect(ctx.port.raise).not.toHaveBeenCalled();
  });

  it('answers RUN_NOT_ACTIVE for a cancelled run as well', async () => {
    ctx.runs.set({ id: RUN, tenantId: TENANT, state: 'cancelled' });
    const res = await post(ctx);
    expect(res.json<{ code: string }>().code).toBe('RUN_NOT_ACTIVE');
  });
});

describe('POST /internal/broker/gate2/exceptions without a wired port', () => {
  it('answers NOT_IMPLEMENTED (501), never a fake success', async () => {
    const bare = await build(undefined);
    try {
      const res = await post(bare);
      expect(res.statusCode).toBe(501);
      expect(res.json<{ code: string }>().code).toBe('NOT_IMPLEMENTED');
    } finally {
      await bare.app.close();
    }
  });
});

describe('POST /internal/broker/gate2/exceptions with a failing port', () => {
  it('surfaces a 503 TEMPORAL_UNAVAILABLE from the port as problem+json', async () => {
    const app = Fastify({ logger: false });
    const runs = new InMemoryBrokerRunReader();
    runs.set({ id: RUN, tenantId: TENANT, state: 'executing' });
    const { AppError } = await import('@blackwing/errors');
    registerBrokerRoutes(app, {
      verifier: createBrokerTokenVerifier({ secret: SECRET, now: () => NOW_S * 1000 }),
      revocations: new InMemoryRunTokenRevocations(),
      sourceGuard: createSourceGuard({
        allowedCidrs: ['10.20.0.0/16'],
        identityHeader: 'x-bw-mesh-identity',
        identities: [IDENTITY],
      }),
      runs,
      audit: new InMemoryBrokerAuditSink(),
      logger: createLogger('api', { level: 'silent' }),
      metrics: createBrokerMetrics(),
      rateLimit: { limit: 1000, windowMs: 60_000 },
      gate2: {
        raise: () => Promise.reject(new AppError('TEMPORAL_UNAVAILABLE', 'signal failed')),
      },
      now: () => NOW_S * 1000,
      environment: 'test',
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        remoteAddress: GOOD_IP,
        headers: {
          authorization: `Bearer ${token()}`,
          'x-bw-mesh-identity': IDENTITY,
          'idempotency-key': KEY,
        },
        payload: BODY,
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json<{ code: string }>().code).toBe('TEMPORAL_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });
});
