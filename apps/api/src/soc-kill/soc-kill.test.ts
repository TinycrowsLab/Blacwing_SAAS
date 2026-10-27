import { generateKeyPairSync } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { type JwsSigner, publicKeyOf, signJws } from '@blackwing/crypto';
import { AuthError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { createInMemorySocKillContext, InMemorySocKillTokenStore } from './memory.js';
import { createSocKillMetrics } from './metrics.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { registerSocKillRoutes } from './routes.js';
import { SOC_KILL_LEEWAY_MS, SOC_KILL_LIMITS, SocKillService } from './service.js';
import {
  harness,
  type Harness,
  LIVE_RUN,
  OTHER_USER,
  OWNED_ASSET,
  OWNER,
  principal,
  TENANT_A,
  TENANT_B,
  UNOWNED_ASSET,
  uuid,
} from '../kill/fixtures.test-helpers.js';
import { createInMemoryKillResources } from '../kill/memory.js';
import { createCedarKillPolicy } from '../kill/policy.js';

import type { KillPrincipal } from '../kill/ports.js';

const ORIGIN = 'https://app.example.test';
const keypair = (kid: string): JwsSigner => ({
  kid,
  privateKey: generateKeyPairSync('ed25519').privateKey,
});
const PREVIOUS = keypair('key-1');
const CURRENT = keypair('key-2');

const TOKENS: Readonly<Record<string, KillPrincipal>> = {
  admin: principal(['org_admin']),
  owner: principal(['asset_owner']),
  otherOwner: principal(['asset_owner'], { id: OTHER_USER }),
  dev: principal(['developer']),
};

interface Rig {
  readonly app: FastifyInstance;
  readonly h: Harness;
  readonly service: SocKillService;
  readonly store: InMemorySocKillTokenStore;
  readonly metrics: ReturnType<typeof createSocKillMetrics>;
  readonly limiter: FixedWindowRateLimiter;
  readonly logs: string[];
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function rig(
  options: { suspended?: string[]; windowEnd?: Date | null; signer?: JwsSigner } = {},
): Promise<Rig> {
  const h = harness();
  const store = new InMemorySocKillTokenStore();
  const metrics = createSocKillMetrics();
  const limiter = new FixedWindowRateLimiter(h.clock);
  const logs: string[] = [];
  const keys = new Map([PREVIOUS, CURRENT].map((s) => [s.kid, publicKeyOf(s)]));
  const windowEnd =
    options.windowEnd === undefined
      ? new Date(h.clock.now().getTime() + 3_600_000)
      : options.windowEnd;
  const service = new SocKillService({
    store,
    context: createInMemorySocKillContext({
      suspendedTenants: options.suspended ?? [],
      labels: { [OWNED_ASSET]: 'Payments API', [LIVE_RUN]: 'Payments API' },
      windowEnds: windowEnd === null ? {} : { [OWNED_ASSET]: windowEnd },
    }),
    kill: h.service,
    resources: harnessResources(),
    policy: harnessPolicy(),
    audit: h.audit,
    limiter,
    signer: options.signer ?? CURRENT,
    resolveKey: (kid) => keys.get(kid),
    linkOrigin: ORIGIN,
    logger: createLogger('soc-kill-test', {
      level: 'debug',
      nodeEnv: 'test',
      destination: { write: (line: string) => logs.push(line) },
    }),
    metrics,
    clock: h.clock,
  });
  const app = Fastify({ routerOptions: { maxParamLength: 1024 } });
  apps.push(app);
  registerSocKillRoutes(app, {
    service,
    environment: 'test',
    authenticate: (request) => {
      const token = /^Bearer (\w+)$/.exec(request.headers.authorization ?? '')?.[1];
      const found = token === undefined ? undefined : TOKENS[token];
      if (found === undefined) return Promise.reject(new AuthError('invalid or revoked token'));
      return Promise.resolve(found);
    },
  });
  await app.ready();
  return { app, h, service, store, metrics, limiter, logs };
}

function harnessResources() {
  return createInMemoryKillResources({
    runs: [{ id: LIVE_RUN, tenantId: TENANT_A }],
    assets: [
      { id: OWNED_ASSET, tenantId: TENANT_A, ownerUserIds: [OWNER] },
      { id: UNOWNED_ASSET, tenantId: TENANT_A, ownerUserIds: [OTHER_USER] },
    ],
  });
}
const harnessPolicy = createCedarKillPolicy;

const mint = async (r: Rig, body: object = {}, bearer = 'admin', asset = OWNED_ASSET) =>
  r.app.inject({
    method: 'POST',
    url: `/v1/assets/${asset}/soc-kill-link`,
    headers: { authorization: `Bearer ${bearer}` },
    payload: body,
  });
const tokenOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1);
const minted = async (r: Rig, body: object = {}): Promise<string> => {
  const res = await mint(r, body);
  expect(res.statusCode).toBe(201);
  return tokenOf(res.json<{ url: string }>().url);
};
const preview = (r: Rig, token: string, ip = '10.0.0.1') =>
  r.app.inject({ method: 'GET', url: `/soc/kill/${token}`, remoteAddress: ip });
const fire = (r: Rig, token: string, ip = '10.0.0.1') =>
  r.app.inject({ method: 'POST', url: '/soc/kill', remoteAddress: ip, payload: { token } });
const rejections = (r: Rig) =>
  r.h.audit.records.filter((x) => x.action === 'soc_kill.rejected').map((x) => x.metadata.reason);

describe('mint', () => {
  it('issues a signed link bound to the open test window and audits it without the token', async () => {
    const r = await rig();
    const res = await mint(r, { contactId: uuid() });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ url: string; expiresAt: string; maxUses: number; scope: string }>();
    expect(body.url.startsWith(`${ORIGIN}/soc/kill/`)).toBe(true);
    expect(body).toMatchObject({
      scope: 'asset',
      maxUses: 3,
      expiresAt: '2026-10-20T11:00:00.000Z',
    });
    const token = tokenOf(body.url);
    const row = r.store.get(TENANT_A, r.h.audit.records[0]?.metadata.tokenId as string);
    expect(row?.tokenSha256.length).toBe(32);
    expect(row?.signingKeyId).toBe('key-2');
    expect(JSON.stringify(r.h.audit.records)).not.toContain(token);
    expect(r.logs.join('')).not.toContain(token);
    expect(r.h.audit.records[0]).toMatchObject({
      action: 'soc_kill.link_minted',
      tenantId: TENANT_A,
    });
  });

  it('caps a far-future expiry at the maximum validity and honours maxUses', async () => {
    const r = await rig();
    const res = await mint(r, { expiresAt: '2030-01-01T00:00:00.000Z', maxUses: 7 });
    expect(res.json<{ expiresAt: string; maxUses: number }>()).toMatchObject({
      expiresAt: '2026-11-19T10:00:00.000Z',
      maxUses: 7,
    });
  });

  it('needs an expiry when the asset has no open test window', async () => {
    const r = await rig({ windowEnd: null });
    expect((await mint(r)).statusCode).toBe(422);
    expect((await mint(r, { expiresAt: '2026-10-20T09:00:00.000Z' })).statusCode).toBe(422);
    expect((await mint(r, { expiresAt: '2026-10-20T12:00:00.000Z' })).statusCode).toBe(201);
  });

  it('refuses callers without kill authority or asset ownership, and bad input', async () => {
    const r = await rig();
    expect((await mint(r, {}, 'dev')).statusCode).toBe(403);
    expect((await mint(r, {}, 'otherOwner')).statusCode).toBe(403);
    expect((await mint(r, {}, 'owner')).statusCode).toBe(201);
    expect((await mint(r, {}, 'nobody')).statusCode).toBe(401);
    expect((await mint(r, {}, 'admin', uuid())).statusCode).toBe(404);
    expect((await mint(r, {}, 'admin', 'not-a-uuid')).statusCode).toBe(404);
    expect((await mint(r, { maxUses: 0 })).statusCode).toBe(422);
    expect((await mint(r, { surprise: true })).statusCode).toBe(422);
  });

  it('revokes the link and fails when the audit append fails (no unaudited live link)', async () => {
    const r = await rig();
    r.h.audit.append = () => Promise.reject(new Error('ledger down'));
    expect((await mint(r)).statusCode).toBe(500);
    expect(
      r.store.get(TENANT_A, r.store.rowsForTest()[0]?.id ?? '')?.revokedAt,
    ).not.toBeNull();
  });
});

describe('confirmation page (GET /soc/kill/{token})', () => {
  it('shows only the scope and asset label, uncached, with no tenant data', async () => {
    const r = await rig();
    const res = await preview(r, await minted(r));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scope: 'asset', label: 'Payments API' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).not.toContain(TENANT_A);
  });

  it('does not consume a use', async () => {
    const r = await rig();
    const token = await minted(r, { maxUses: 1 });
    await preview(r, token);
    await preview(r, token);
    expect((await fire(r, token)).statusCode).toBe(202);
  });
});

describe('trigger (POST /soc/kill)', () => {
  it('a valid link triggers a kill that propagates, sourced soc_link', async () => {
    const r = await rig();
    const res = await fire(r, await minted(r));
    expect(res.statusCode).toBe(202);
    const { killEventId } = res.json<{ killEventId: string }>();
    const event = r.h.store.list(TENANT_A).find((e) => e.id === killEventId);
    expect(event).toMatchObject({
      source: 'soc_link',
      scope: 'asset',
      scopeRefId: OWNED_ASSET,
      actorType: 'soc_link',
    });
    expect(r.h.signaler.requests).toHaveLength(1);
    expect(r.h.signaler.requests[0]).toMatchObject({ tenantId: TENANT_A, scope: 'asset' });
    const audit = r.h.audit.records.find((x) => x.action === 'soc_kill.triggered');
    expect(audit).toMatchObject({ actor: { type: 'anonymous' }, severity: 'critical' });
    expect(await r.metrics.registry.getSingleMetricAsString('bw_soc_kill_total')).toContain(
      'triggered',
    );
  });

  it('replay after the last use is rejected and audited soc_kill.rejected', async () => {
    const r = await rig();
    const token = await minted(r, { maxUses: 1 });
    expect((await fire(r, token)).statusCode).toBe(202);
    const again = await fire(r, token);
    expect(again.statusCode).toBe(404);
    expect((await preview(r, token)).statusCode).toBe(404);
    expect(r.h.signaler.requests).toHaveLength(1);
    expect(rejections(r)[0]).toBe('used');
  });

  it('two concurrent triggers of a single-use link start exactly one kill', async () => {
    const r = await rig();
    const token = await minted(r, { maxUses: 1 });
    const results = await Promise.all([fire(r, token, '10.0.0.2'), fire(r, token, '10.0.0.3')]);
    expect(results.map((x) => x.statusCode).sort()).toEqual([202, 404]);
  });

  it('gives the use back when the kill could not be started', async () => {
    const r = await rig();
    const token = await minted(r, { maxUses: 1 });
    const failing = r.h.store.insertOrGet.bind(r.h.store);
    r.h.store.insertOrGet = () => Promise.reject(new Error('db down'));
    expect((await fire(r, token)).statusCode).toBe(500);
    r.h.store.insertOrGet = failing;
    expect((await fire(r, token)).statusCode).toBe(202);
  });

  it('rejects an expired link, with the +/-60 s leeway documented and tested', async () => {
    const r = await rig();
    const token = await minted(r);
    r.h.clock.set('2026-10-20T11:00:00.000Z');
    r.h.clock.advance(SOC_KILL_LEEWAY_MS - 1000);
    expect((await preview(r, token)).statusCode).toBe(200);
    r.h.clock.advance(2000 + 1);
    const res = await fire(r, token);
    expect(res.statusCode).toBe(404);
    expect(r.h.signaler.requests).toHaveLength(0);
    expect(rejections(r)).toEqual(['expired']);
  });

  it('rejects a revoked link', async () => {
    const r = await rig();
    const token = await minted(r);
    const id = r.h.audit.records[0]?.metadata.tokenId as string;
    await r.store.revoke(TENANT_A, id, r.h.clock.now());
    expect((await fire(r, token)).statusCode).toBe(404);
    expect(rejections(r)).toEqual(['revoked']);
  });

  it('rejects links of a suspended tenant', async () => {
    const r = await rig({ suspended: [TENANT_A] });
    const token = await minted(r);
    expect((await fire(r, token)).statusCode).toBe(404);
    expect(rejections(r)).toEqual(['tenant_suspended']);
  });

  it('still allows stopping when the asset is no longer verified (kill is never blocked)', async () => {
    const r = await rig();
    expect((await fire(r, await minted(r))).statusCode).toBe(202);
  });

  it('verifies against the previous signing key after a rotation', async () => {
    const r = await rig({ signer: PREVIOUS });
    expect((await fire(r, await minted(r))).statusCode).toBe(202);
  });

  it('rejects malformed bodies', async () => {
    const r = await rig();
    for (const payload of [{}, { token: 1 }, { token: 'x', extra: 1 }, { token: '' }]) {
      const res = await r.app.inject({ method: 'POST', url: '/soc/kill', payload });
      expect(res.statusCode).toBe(422);
    }
  });
});

describe('forged and tampered tokens (uniform, un-auditable answers)', () => {
  const claims = (over: object = {}) => ({
    tenantId: TENANT_A,
    scope: 'asset',
    scopeRefId: OWNED_ASSET,
    jti: uuid(),
    exp: Math.floor(Date.parse('2026-10-20T11:00:00.000Z') / 1000),
    ...over,
  });

  it('rejects a tampered token, a foreign-key token and junk with the same 404', async () => {
    const r = await rig();
    const good = await minted(r);
    const [h, , s] = good.split('.') as [string, string, string];
    const other = Buffer.from(JSON.stringify(claims())).toString('base64url');
    const bodies = [
      `${h}.${other}.${s}`,
      signJws(claims(), keypair('key-2')),
      signJws(claims(), keypair('unknown-key')),
      'garbage',
      'a.b.c',
    ];
    const answers = await Promise.all(bodies.map((t) => fire(r, t)));
    expect(new Set(answers.map((a) => a.statusCode))).toEqual(new Set([404]));
    expect(new Set(answers.map((a) => a.body.replace(/"traceId":"[^"]+"/, '')))).toHaveProperty(
      'size',
      1,
    );
    expect(r.h.signaler.requests).toHaveLength(0);
    expect(r.h.audit.records.filter((x) => x.action === 'soc_kill.rejected')).toHaveLength(0);
    expect(await r.metrics.registry.getSingleMetricAsString('bw_soc_kill_total')).toContain(
      'invalid_signature',
    );
  });

  it('rejects a validly signed token that was never stored, or does not match its row', async () => {
    const r = await rig();
    const stray = signJws(claims(), CURRENT);
    expect((await fire(r, stray)).statusCode).toBe(404);
    expect(rejections(r)).toEqual(['unknown_token']);
  });

  it('never trusts the tenant of another tenant link: a token cannot reach a foreign row', async () => {
    const r = await rig();
    const token = signJws(claims({ tenantId: TENANT_B }), CURRENT);
    expect((await fire(r, token)).statusCode).toBe(404);
    expect(r.h.signaler.requests).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('soc_kill.ratelimit: 429 with Retry-After after the per-IP threshold', async () => {
    const r = await rig();
    const token = await minted(r);
    for (let i = 0; i < SOC_KILL_LIMITS.verifyPerIp; i += 1) {
      expect((await preview(r, token, '203.0.113.9')).statusCode).toBe(200);
    }
    const limited = await preview(r, token, '203.0.113.9');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // another address is unaffected, and the window reopens
    expect((await preview(r, token, '203.0.113.10')).statusCode).toBe(200);
    r.h.clock.advance('61s');
    expect((await preview(r, token, '203.0.113.9')).statusCode).toBe(200);
    expect(
      await r.metrics.registry.getSingleMetricAsString('bw_soc_kill_ratelimited_total'),
    ).toContain('verify');
  });

  it('limits a single token across many addresses', async () => {
    const r = await rig();
    const token = await minted(r, { maxUses: 100 });
    const codes: number[] = [];
    for (let i = 0; i < SOC_KILL_LIMITS.triggerPerToken + 2; i += 1) {
      codes.push((await fire(r, token, `198.51.100.${String(i + 1)}`)).statusCode);
    }
    expect(codes.slice(0, SOC_KILL_LIMITS.triggerPerToken)).toEqual(
      new Array<number>(SOC_KILL_LIMITS.triggerPerToken).fill(202),
    );
    expect(codes.slice(-2)).toEqual([429, 429]);
  });

  it('limits garbage guessing per IP before any verification', async () => {
    const r = await rig();
    for (let i = 0; i < SOC_KILL_LIMITS.triggerPerIp; i += 1) await fire(r, 'junk', '192.0.2.1');
    expect((await fire(r, 'junk', '192.0.2.1')).statusCode).toBe(429);
  });
});

describe('FixedWindowRateLimiter', () => {
  it('fails closed instead of growing past its key cap', () => {
    const h = harness();
    const limiter = new FixedWindowRateLimiter(h.clock, 2);
    expect(limiter.hit('a', 5, 1000).allowed).toBe(true);
    expect(limiter.hit('b', 5, 1000).allowed).toBe(true);
    expect(limiter.hit('c', 5, 1000).allowed).toBe(false);
    h.clock.advance(1001);
    expect(limiter.hit('c', 5, 1000).allowed).toBe(true);
  });
});
