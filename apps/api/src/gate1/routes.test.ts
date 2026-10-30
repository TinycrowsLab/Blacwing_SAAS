import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthError } from '@blackwing/errors';
import { FixedClock } from '@blackwing/time';

import { InMemoryGate1AuditSink, InMemoryGate1Signaler, InMemoryGate1Store } from './memory.js';
import { createCedarGate1Policy } from './policy.js';
import { registerGate1Routes } from './routes.js';
import { Gate1Service } from './service.js';

import type { Gate1Plan, Gate1PlanValidator, Gate1Principal, Gate1RunRecord } from './ports.js';
import type { Gate1TestCase } from '@blackwing/contracts';

const TENANT = '0190a5d0-1111-7111-8111-111111111111';
const RUN = 'run_01jbz3k6w8f5r4t2n9q7x0m1ab';
const REQUESTER = 'user-requester';
const KEY = 'gate1-route-key-001';

const budget = { maxRequests: 10, maxRps: 1, maxConcurrency: 1, maxBytes: 100 };
const testCase: Gate1TestCase = {
  id: 'tc-1',
  title: 'Headers reviewed',
  class: 'passive',
  targets: ['https://lab.example.test/'],
  budget,
};
const plan: Gate1Plan = {
  planVersion: 3,
  requestedAt: '2026-10-29T08:00:00.000Z',
  expiresAt: '2026-10-29T12:00:00.000Z',
  testCases: [testCase],
};
const run: Gate1RunRecord = {
  id: RUN,
  tenantId: TENANT,
  state: 'awaiting_gate1',
  stateVersion: 1,
  requesterId: REQUESTER,
  plan,
  priorPlan: null,
};

/** Bearer tokens the fake authenticator knows. `revoked` mimics a revoked or expired credential. */
const TOKENS: Readonly<Record<string, Gate1Principal | 'revoked'>> = {
  approver: { type: 'user', id: 'user-approver', tenantId: TENANT, roles: ['asset_owner'] },
  requester: { type: 'user', id: REQUESTER, tenantId: TENANT, roles: ['asset_owner'] },
  submitter: { type: 'user', id: REQUESTER, tenantId: TENANT, roles: ['appsec_engineer'] },
  developer: { type: 'user', id: 'user-dev', tenantId: TENANT, roles: ['developer'] },
  revoked: 'revoked',
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const planningRun: Gate1RunRecord = { ...run, state: 'planning', stateVersion: 0 };
const validPlan: Gate1PlanValidator = { validate: () => Promise.resolve({ valid: true }) };

async function server(
  seed: Gate1RunRecord = run,
  validator: Gate1PlanValidator = validPlan,
): Promise<{
  app: FastifyInstance;
  audit: InMemoryGate1AuditSink;
  signaler: InMemoryGate1Signaler;
}> {
  const app = Fastify();
  apps.push(app);
  const audit = new InMemoryGate1AuditSink();
  const signaler = new InMemoryGate1Signaler();
  const service = new Gate1Service({
    store: new InMemoryGate1Store([seed]),
    audit,
    validator,
    signaler,
    policy: createCedarGate1Policy(),
    clock: new FixedClock('2026-10-29T10:00:00.000Z'),
  });
  registerGate1Routes(app, {
    service,
    environment: 'test',
    authenticate: (request) => {
      const token = /^Bearer (\w+)$/.exec(request.headers.authorization ?? '')?.[1];
      const found = token === undefined ? undefined : TOKENS[token];
      if (found === undefined || found === 'revoked') {
        return Promise.reject(new AuthError('invalid or revoked token'));
      }
      return Promise.resolve(found);
    },
  });
  await app.ready();
  return { app, audit, signaler };
}

const get = (app: FastifyInstance, token: string) =>
  app.inject({
    method: 'GET',
    url: `/v1/runs/${RUN}/gate1`,
    headers: { authorization: `Bearer ${token}` },
  });

const submit = (app: FastifyInstance, token: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/runs/${RUN}/gate1/submit`,
    headers: { authorization: `Bearer ${token}` },
  });

const decide = (app: FastifyInstance, token: string, payload: unknown, key: string | null = KEY) =>
  app.inject({
    method: 'POST',
    url: `/v1/runs/${RUN}/gate1/decisions`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
    payload: payload as object,
  });

describe('Gate 1 routes', () => {
  it('serves the plan to an approver with no-store caching', async () => {
    const { app } = await server();
    const res = await get(app, 'approver');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      runId: RUN,
      planVersion: 3,
      viewer: { canDecide: true, isRequester: false },
    });
  });

  it('refuses a revoked or expired credential before the handler runs (401)', async () => {
    const { app, audit } = await server();
    const read = await get(app, 'revoked');
    expect(read.statusCode).toBe(401);
    const write = await decide(app, 'revoked', { decision: 'approve', planVersion: 3 });
    expect(write.statusCode).toBe(401);
    expect(audit.records).toHaveLength(0);
  });

  it('approves for a different approver (200) and replays the same key', async () => {
    const { app, audit } = await server();
    const first = await decide(app, 'approver', { decision: 'approve', planVersion: 3 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ runId: RUN, decision: 'approve', runState: 'approved' });
    const replay = await decide(app, 'approver', { decision: 'approve', planVersion: 3 });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(audit.records.filter((r) => r.outcome === 'success')).toHaveLength(1);
  });

  it('answers the requester with a problem+json 403 SOD_VIOLATION, even when the UI missed it', async () => {
    const { app, audit } = await server();
    const res = await decide(app, 'requester', { decision: 'approve', planVersion: 3 });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 403, code: 'SOD_VIOLATION' });
    expect(audit.records[0]?.outcome).toBe('denied');
  });

  it('answers a caller without testplan:approve with 403 FORBIDDEN', async () => {
    const { app } = await server();
    const res = await decide(app, 'developer', { decision: 'approve', planVersion: 3 });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('answers 400 when the Idempotency-Key header is missing', async () => {
    const { app } = await server();
    const res = await decide(app, 'approver', { decision: 'approve', planVersion: 3 }, null);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('answers 422 for a reason-less reject and for unknown body fields', async () => {
    const { app } = await server();
    const noReason = await decide(app, 'approver', { decision: 'reject', planVersion: 3 });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json()).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    const extra = await decide(app, 'approver', {
      decision: 'approve',
      planVersion: 3,
      runState: 'released',
    });
    expect(extra.statusCode).toBe(422);
  });

  it('answers 409 with a stable code for a stale plan version', async () => {
    const { app } = await server();
    const res = await decide(app, 'approver', { decision: 'approve', planVersion: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: 409, code: 'GATE1_PLAN_STALE' });
  });

  it('answers 404 for a run that does not exist in the tenant', async () => {
    const { app } = await server();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/runs/run_missing0000/gate1',
      headers: { authorization: 'Bearer approver' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('submits a valid plan for Gate 1 (200), moving the run to awaiting_gate1', async () => {
    const { app, audit, signaler } = await server(planningRun);
    const res = await submit(app, 'submitter');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runId: RUN, planVersion: 3, runState: 'awaiting_gate1' });
    expect(signaler.signals).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ action: 'gate1.submitted', outcome: 'success' });
  });

  it('answers 422 GATE1_PLAN_INVALID for an invalid plan and signals nothing', async () => {
    const invalid: Gate1PlanValidator = {
      validate: () => Promise.resolve({ valid: false, violations: ['case tc-1 has no oracle'] }),
    };
    const { app, signaler } = await server(planningRun, invalid);
    const res = await submit(app, 'submitter');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ status: 422, code: 'GATE1_PLAN_INVALID' });
    expect(signaler.signals).toHaveLength(0);
  });

  it('answers 409 ILLEGAL_RUN_TRANSITION when the run is not planning', async () => {
    const { app } = await server();
    const res = await submit(app, 'submitter');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: 409, code: 'ILLEGAL_RUN_TRANSITION' });
  });

  it('answers 403 FORBIDDEN to a caller without testplan:edit on submit', async () => {
    const { app } = await server(planningRun);
    const res = await submit(app, 'approver');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('answers 401 for a revoked credential on submit before the handler runs', async () => {
    const { app } = await server(planningRun);
    const res = await submit(app, 'revoked');
    expect(res.statusCode).toBe(401);
  });
});
