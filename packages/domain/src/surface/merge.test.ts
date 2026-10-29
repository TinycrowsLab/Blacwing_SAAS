import { describe, expect, it, vi } from 'vitest';

import { parseScopeRules, type ScopeRules } from '@blackwing/contracts';
import { TenantContextMissingError, ValidationError } from '@blackwing/errors';

import { InvalidSurfaceInputError, SurfaceBatchTooLargeError } from './errors.js';
import { hostKey, technologyKey } from './fingerprint.js';
import {
  emptySurfaceModel,
  getMergedSurface,
  mergeSurfaceWrite,
  readMergedSurface,
  type SurfaceMergeContext,
  type SurfaceModel,
  type SurfaceModelStore,
  SURFACE_CONFLICTS_METRIC,
  SURFACE_MERGE_SPAN,
  SURFACE_NODES_METRIC,
} from './merge.js';
import { type SurfaceNode, type SurfaceProvenance, surfaceNodeKey } from './write.js';

const ASSET = '0190a000-0000-7000-8000-000000000001';
const TENANT = '0190a000-0000-7000-8000-0000000000aa';
const OTHER_TENANT = '0190a000-0000-7000-8000-0000000000ab';
const RUN = '0190a000-0000-7000-8000-0000000000b1';
const SESSION = '0190a000-0000-7000-8000-0000000000b2';
const SESSION_B = '0190a000-0000-7000-8000-0000000000b3';

const SCOPE: ScopeRules = parseScopeRules({
  rules: [{ effect: 'include', host: '*.a.example' }],
});

const prov = (over: Partial<SurfaceProvenance> = {}): SurfaceProvenance => ({
  runId: RUN,
  sessionId: SESSION,
  persona: 'recon-web',
  tool: 'httpx',
  toolVersion: '1.0.0',
  sourceKind: 'passive',
  confidence: 0.5,
  observedAt: '2026-10-29T10:00:00.000Z',
  ...over,
});

const host = (over: Partial<Extract<SurfaceNode, { type: 'host' }>> = {}): SurfaceNode => ({
  type: 'host',
  assetId: ASSET,
  address: 'www.a.example',
  ...over,
});

const tech = (version?: string, product = 'nginx'): SurfaceNode => ({
  type: 'technology',
  assetId: ASSET,
  address: 'www.a.example',
  product,
  ...(version === undefined ? {} : { version }),
});

const endpoint = (url: string, method = 'get'): SurfaceNode => ({
  type: 'endpoint',
  assetId: ASSET,
  method,
  url,
});

/** A raw batch as a recon tool sends it. The merge parses it, so malformed input is rejected there. */
const write = (
  nodes: unknown[],
  over: {
    provenance?: Partial<SurfaceProvenance> | Record<string, unknown>;
    edges?: unknown[];
  } = {},
): unknown => ({
  nodes,
  edges: over.edges ?? [],
  provenance: { ...prov(), ...over.provenance },
});

const MODEL_KEY = `${TENANT}/${RUN}`;

/** An in-memory store that serialises updates per (tenant, run) and persists only on success. */
function memoryStore(): SurfaceModelStore & { models: Map<string, SurfaceModel> } {
  const models = new Map<string, SurfaceModel>();
  const chains = new Map<string, Promise<unknown>>();
  const empty = emptySurfaceModel;
  return {
    models,
    update<T>(tenantId: string, runId: string, fn: (model: SurfaceModel) => T): Promise<T> {
      const id = `${tenantId}/${runId}`;
      const run = (chains.get(id) ?? Promise.resolve()).then(() => {
        const draft = structuredClone(models.get(id) ?? empty());
        const result = fn(draft);
        models.set(id, draft);
        return result;
      });
      chains.set(
        id,
        run.catch(() => undefined),
      );
      return run;
    },
    read(tenantId, runId) {
      return Promise.resolve(structuredClone(models.get(`${tenantId}/${runId}`) ?? empty()));
    },
  };
}

const ctx = (over: Partial<SurfaceMergeContext> = {}): SurfaceMergeContext => ({
  tenantId: TENANT,
  scope: SCOPE,
  ...over,
});

const typesOf = (nodes: readonly { type: string }[]): string[] => nodes.map((n) => n.type).sort();

describe('mergeSurfaceWrite and getMergedSurface: convergence', () => {
  it('two sources reporting the same host and endpoint produce one node with both provenance entries', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([host(), endpoint('https://www.a.example/users/42?sort=asc')], {
        provenance: { confidence: 0.4, persona: 'passive' },
      }),
    );
    await mergeSurfaceWrite(
      ctx(),
      store,
      write(
        [
          host({ address: 'WWW.A.EXAMPLE.' }),
          endpoint('https://WWW.a.example/users/7?sort=desc', 'GET'),
        ],
        {
          provenance: {
            sessionId: SESSION_B,
            persona: 'active',
            sourceKind: 'active',
            confidence: 0.9,
            tool: 'probe',
          },
        },
      ),
    );

    const page = await getMergedSurface(ctx(), store, RUN);
    expect(typesOf(page.nodes)).toEqual(['endpoint', 'host']);
    const ep = page.nodes.find((n) => n.type === 'endpoint');
    expect(ep?.key).toBe(surfaceNodeKey(endpoint('https://www.a.example/users/42?sort=asc')));
    expect(ep?.identity).toEqual({
      type: 'endpoint',
      assetId: ASSET,
      method: 'GET',
      url: 'https://www.a.example/users/{id}?sort',
    });
    expect(ep?.provenance.map((p) => p.persona)).toEqual(['passive', 'active']);
    expect(ep?.confidence).toBe(0.9);
    expect(page.nodes.find((n) => n.type === 'host')?.provenance).toHaveLength(2);
  });

  it('a replayed write is an idempotent no-op with no duplicate provenance', async () => {
    const store = memoryStore();
    const input = write([host()]);
    const first = await mergeSurfaceWrite(ctx(), store, input);
    const second = await mergeSurfaceWrite(ctx(), store, input);
    expect(first.created).toEqual({ host: 1 });
    expect(second.created).toEqual({});
    const [node] = (await getMergedSurface(ctx(), store, RUN)).nodes;
    expect(node?.provenance).toHaveLength(1);
  });

  it('the same observations in another order give the same projection', async () => {
    const a = memoryStore();
    const b = memoryStore();
    const first = write([tech('1.18.0')], { provenance: { confidence: 0.6, persona: 'p1' } });
    const second = write([tech('1.20.1')], {
      provenance: { confidence: 0.6, persona: 'p2', sourceKind: 'active' },
    });
    await mergeSurfaceWrite(ctx(), a, first);
    await mergeSurfaceWrite(ctx(), a, second);
    await mergeSurfaceWrite(ctx(), b, second);
    await mergeSurfaceWrite(ctx(), b, first);
    const pa = await getMergedSurface(ctx(), a, RUN);
    const pb = await getMergedSurface(ctx(), b, RUN);
    const summary = (p: typeof pa) => p.nodes.map((n) => [n.key, n.alternatives, n.conflicts]);
    expect(summary(pa)).toEqual(summary(pb));
  });

  it('concurrent writes to one run all land, once each, and a second round is idempotent', async () => {
    const store = memoryStore();
    const batches = [1, 2, 3, 4, 5].map((i) =>
      write([host({ address: `h${i}.a.example` })], {
        provenance: { sessionId: i === 1 ? SESSION : SESSION_B, persona: `p${i}` },
      }),
    );
    await Promise.all(batches.map((b) => mergeSurfaceWrite(ctx(), store, b)));
    await Promise.all(batches.map((b) => mergeSurfaceWrite(ctx(), store, b)));
    const page = await getMergedSurface(ctx(), store, RUN, { limit: 200 });
    expect(page.nodes).toHaveLength(5);
    for (const node of page.nodes) expect(node.provenance).toHaveLength(1);
  });

  it('a rejected batch leaves the model untouched (no partial merge)', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(ctx(), store, write([host()]));
    const before = structuredClone(store.models);
    await expect(
      mergeSurfaceWrite(ctx(), store, write([host({ address: 'b.a.example' }), tech('1', ' ')])),
    ).rejects.toBeInstanceOf(InvalidSurfaceInputError);
    expect(store.models).toEqual(before);
    await expect(mergeSurfaceWrite(ctx(), store, { nodes: 'nope' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects an oversized batch before touching the store', async () => {
    const store = memoryStore();
    const nodes = Array.from({ length: 501 }, (_, i) => host({ address: `h${i}.a.example` }));
    await expect(mergeSurfaceWrite(ctx(), store, write(nodes))).rejects.toBeInstanceOf(
      SurfaceBatchTooLargeError,
    );
    expect(store.models.size).toBe(0);
  });

  it('defaults a missing source kind to passive and rejects an unknown one', async () => {
    const store = memoryStore();
    const noKind: Partial<SurfaceProvenance> = prov();
    delete noKind.sourceKind;
    await mergeSurfaceWrite(ctx(), store, { nodes: [host()], edges: [], provenance: noKind });
    const [node] = (await getMergedSurface(ctx(), store, RUN)).nodes;
    expect(node?.provenance[0]?.sourceKind).toBe('passive');
    await expect(
      mergeSurfaceWrite(ctx(), store, write([host()], { provenance: { sourceKind: 'trusted' } })),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('conflicting technology versions', () => {
  it('keeps every version as an alternative with a deterministic primary (highest confidence)', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([tech('1.18.0')], { provenance: { confidence: 0.4 } }),
    );
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([tech('1.20.1')], { provenance: { confidence: 0.8, sessionId: SESSION_B } }),
    );
    const [node] = (await getMergedSurface(ctx(), store, RUN)).nodes;
    expect(node?.type).toBe('technology');
    expect(node?.key).toBe(technologyKey(hostKey(ASSET, 'www.a.example'), 'nginx'));
    expect(node?.alternatives).toEqual([
      { version: '1.20.1', confidence: 0.8, sourceKind: 'passive' },
      { version: '1.18.0', confidence: 0.4, sourceKind: 'passive' },
    ]);
    expect(node?.conflicts).toEqual(['version']);
    expect(node?.confidence).toBe(0.8);
  });

  it('breaks a confidence tie by source rank: active beats passive', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([tech('2.0')], { provenance: { confidence: 0.7 } }),
    );
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([tech('2.1')], {
        provenance: { confidence: 0.7, sourceKind: 'active', sessionId: SESSION_B },
      }),
    );
    const [node] = (await getMergedSurface(ctx(), store, RUN)).nodes;
    expect(node?.alternatives?.[0]).toEqual({
      version: '2.1',
      confidence: 0.7,
      sourceKind: 'active',
    });
  });

  it('breaks a full tie by version text, so replays agree', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([tech('3.0')], { provenance: { confidence: 0.5 } }),
    );
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([tech('2.9')], { provenance: { confidence: 0.5, sessionId: SESSION_B } }),
    );
    const [node] = (await getMergedSurface(ctx(), store, RUN)).nodes;
    expect(node?.alternatives?.map((a) => a.version)).toEqual(['2.9', '3.0']);
  });

  it('counts the conflict once when it first appears, not on every later write', async () => {
    const increment = vi.fn();
    const store = memoryStore();
    await mergeSurfaceWrite(ctx({ increment }), store, write([tech('1.0')]));
    await mergeSurfaceWrite(
      ctx({ increment }),
      store,
      write([tech('1.1')], { provenance: { sessionId: SESSION_B } }),
    );
    await mergeSurfaceWrite(
      ctx({ increment }),
      store,
      write([tech('1.2')], { provenance: { sessionId: SESSION_B } }),
    );
    const conflictCalls = increment.mock.calls.filter(
      ([metric]) => metric === SURFACE_CONFLICTS_METRIC,
    );
    expect(conflictCalls).toEqual([[SURFACE_CONFLICTS_METRIC, {}, 1]]);
  });

  it('keeps a version-less observation as an alternative too', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(ctx(), store, write([tech()]));
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([tech('5.0')], { provenance: { confidence: 0.2, sessionId: SESSION_B } }),
    );
    const [node] = (await getMergedSurface(ctx(), store, RUN)).nodes;
    expect(node?.alternatives?.map((a) => a.version)).toEqual([null, '5.0']);
    expect(node?.conflicts).toEqual(['version']);
  });
});

describe('attribute conflicts resolve by source rank', () => {
  it('a pinned IP from an active source beats a passive one, and both stay in provenance', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([host({ pinnedIp: '203.0.113.5' })], { provenance: { confidence: 0.9 } }),
    );
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([host({ pinnedIp: '203.0.113.9' })], {
        provenance: { sourceKind: 'active', confidence: 0.3, sessionId: SESSION_B },
      }),
    );
    const [node] = (await getMergedSurface(ctx(), store, RUN)).nodes;
    expect(node?.pinnedIp).toBe('203.0.113.9');
    expect(node?.provenance).toHaveLength(2);
    expect(node?.conflicts).toEqual(['pinnedIp']);
  });

  it('a service name keeps the ingested value over a historical one', async () => {
    const store = memoryStore();
    const svc = (name: string): SurfaceNode => ({
      type: 'service',
      assetId: ASSET,
      address: 'www.a.example',
      port: 443,
      proto: 'tcp',
      name,
    });
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([svc('https-old')], { provenance: { sourceKind: 'historical' } }),
    );
    await mergeSurfaceWrite(
      ctx(),
      store,
      write([svc('https')], { provenance: { sourceKind: 'ingested', sessionId: SESSION_B } }),
    );
    const [node] = (await getMergedSurface(ctx(), store, RUN)).nodes;
    expect(node?.name).toBe('https');
    expect(node?.conflicts).toEqual(['name']);
  });
});

describe('scope filtering at merge time', () => {
  it('an out-of-scope node is dropped, never appears, and its key is tombstoned', async () => {
    const store = memoryStore();
    const bad = host({ address: 'evil.other.example' });
    const stats = await mergeSurfaceWrite(ctx(), store, write([bad]));
    expect(stats).toEqual({ created: {}, conflicts: 0, filtered: 1 });
    expect((await getMergedSurface(ctx(), store, RUN)).nodes).toEqual([]);
    expect([...(store.models.get(MODEL_KEY)?.tombstones ?? [])]).toEqual([surfaceNodeKey(bad)]);
  });

  it('an out-of-scope node re-sent later is still filtered, even alongside an in-scope one', async () => {
    const store = memoryStore();
    const bad = host({ address: 'evil.other.example' });
    await mergeSurfaceWrite(ctx(), store, write([bad]));
    const stats = await mergeSurfaceWrite(ctx(), store, write([bad, host()]));
    expect(stats.filtered).toBe(1);
    expect((await getMergedSurface(ctx(), store, RUN)).nodes.map((n) => n.type)).toEqual(['host']);
  });

  it('edges touching an out-of-scope node are dropped and create no placeholder', async () => {
    const store = memoryStore();
    const good = host();
    const bad = host({ address: 'evil.other.example' });
    const edge = { type: 'serves', from: surfaceNodeKey(good), to: surfaceNodeKey(bad) };
    const stats = await mergeSurfaceWrite(ctx(), store, write([good, bad], { edges: [edge] }));
    expect(stats.filtered).toBe(2);
    const model = store.models.get(MODEL_KEY);
    expect(model?.edges.size).toBe(0);
    expect([...(model?.entities.keys() ?? [])]).toEqual([surfaceNodeKey(good)]);
  });

  it('a placeholder made for an endpoint that later proves out of scope is removed', async () => {
    const store = memoryStore();
    const bad = host({ address: 'evil.other.example' });
    const badKey = surfaceNodeKey(bad);
    const edge = { type: 'serves', from: surfaceNodeKey(host()), to: badKey };
    await mergeSurfaceWrite(ctx(), store, write([host()], { edges: [edge] }));
    expect(store.models.get(MODEL_KEY)?.entities.get(badKey)?.identity).toBeNull();
    await mergeSurfaceWrite(ctx(), store, write([bad]));
    const model = store.models.get(MODEL_KEY);
    expect(model?.entities.has(badKey)).toBe(false);
    expect(model?.tombstones.has(badKey)).toBe(true);
    expect((await getMergedSurface(ctx(), store, RUN)).edges).toEqual([]);
  });

  it('a port-restricted scope keeps host and technology nodes at address level', async () => {
    const store = memoryStore();
    const scoped: ScopeRules = parseScopeRules({
      rules: [{ effect: 'include', host: '*.a.example', ports: [443] }],
    });
    await mergeSurfaceWrite(
      { tenantId: TENANT, scope: scoped },
      store,
      write([host(), tech('1.0')]),
    );
    const page = await getMergedSurface(ctx(), store, RUN);
    expect(typesOf(page.nodes)).toEqual(['host', 'technology']);
  });

  it('empty scope rules deny everything (default deny)', async () => {
    const store = memoryStore();
    const stats = await mergeSurfaceWrite(
      { tenantId: TENANT, scope: parseScopeRules({ rules: [] }) },
      store,
      write([host()]),
    );
    expect(stats.filtered).toBe(1);
    expect((await getMergedSurface(ctx(), store, RUN)).nodes).toEqual([]);
  });
});

describe('placeholders for edges that arrive before their node', () => {
  it('a placeholder is hidden from the planner until its node arrives, then reconciled', async () => {
    const store = memoryStore();
    const h = host();
    const e = endpoint('https://www.a.example/login');
    const edge = { type: 'exposes', from: surfaceNodeKey(h), to: surfaceNodeKey(e) };
    await mergeSurfaceWrite(ctx(), store, write([h], { edges: [edge] }));
    let page = await getMergedSurface(ctx(), store, RUN);
    expect(typesOf(page.nodes)).toEqual(['host']);
    expect(page.edges).toEqual([]);

    await mergeSurfaceWrite(ctx(), store, write([e]));
    page = await getMergedSurface(ctx(), store, RUN);
    expect(typesOf(page.nodes)).toEqual(['endpoint', 'host']);
    expect(page.edges).toEqual([
      { type: 'exposes', from: surfaceNodeKey(h), to: surfaceNodeKey(e) },
    ]);
  });

  it('an edge to a technology version resolves to the product entity once the node arrives', async () => {
    const store = memoryStore();
    const h = host();
    const t = tech('1.18.0');
    const edge = { type: 'runs', from: surfaceNodeKey(h), to: surfaceNodeKey(t) };
    await mergeSurfaceWrite(ctx(), store, write([h], { edges: [edge] }));
    await mergeSurfaceWrite(ctx(), store, write([t]));
    const page = await getMergedSurface(ctx(), store, RUN);
    const techKey = technologyKey(hostKey(ASSET, 'www.a.example'), 'nginx');
    expect(page.edges).toEqual([{ type: 'runs', from: surfaceNodeKey(h), to: techKey }]);
    expect(store.models.get(MODEL_KEY)?.entities.has(surfaceNodeKey(t))).toBe(false);
  });

  it('an edge written twice is stored once', async () => {
    const store = memoryStore();
    const h = host();
    const e = endpoint('https://www.a.example/x');
    const edge = { type: 'exposes', from: surfaceNodeKey(h), to: surfaceNodeKey(e) };
    await mergeSurfaceWrite(ctx(), store, write([h, e], { edges: [edge] }));
    await mergeSurfaceWrite(ctx(), store, write([], { edges: [edge] }));
    expect(store.models.get(MODEL_KEY)?.edges.size).toBe(1);
  });
});

describe('getMergedSurface pagination and validation', () => {
  it('pages through the projection in key order with a cursor, covering every node once', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(
      ctx(),
      store,
      write(Array.from({ length: 5 }, (_, i) => host({ address: `h${i}.a.example` }))),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await getMergedSurface(ctx(), store, RUN, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.nodes.map((n) => n.key));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort());
  });

  it('a page with no next cursor is the last one', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(ctx(), store, write([host()]));
    const page = await getMergedSurface(ctx(), store, RUN, { limit: 1 });
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a bad run id, limit or cursor', async () => {
    const store = memoryStore();
    await expect(getMergedSurface(ctx(), store, 'not-a-uuid')).rejects.toBeInstanceOf(
      ValidationError,
    );
    for (const limit of [0, 201, 1.5]) {
      await expect(getMergedSurface(ctx(), store, RUN, { limit })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    await expect(
      getMergedSurface(ctx(), store, RUN, { cursor: 'DROP TABLE' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a projection read directly is pure and leaves the model unchanged', () => {
    const model = emptySurfaceModel();
    expect(readMergedSurface(model)).toEqual({ nodes: [], edges: [], nextCursor: null });
    expect(model).toEqual(emptySurfaceModel());
  });
});

describe('tenant isolation and fail-closed context', () => {
  it('a run written by one tenant reads as empty for another tenant', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(ctx(), store, write([host()]));
    expect((await getMergedSurface({ tenantId: OTHER_TENANT }, store, RUN)).nodes).toEqual([]);
    expect((await getMergedSurface(ctx(), store, RUN)).nodes).toHaveLength(1);
  });

  it('a write under another tenant never reaches this tenant model', async () => {
    const store = memoryStore();
    await mergeSurfaceWrite(ctx({ tenantId: OTHER_TENANT }), store, write([host()]));
    expect((await getMergedSurface(ctx(), store, RUN)).nodes).toEqual([]);
  });

  it('fails closed without a valid tenant context on write and read', async () => {
    const store = memoryStore();
    await expect(
      mergeSurfaceWrite(ctx({ tenantId: '' }), store, write([host()])),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(
      mergeSurfaceWrite(ctx({ tenantId: 'acme' }), store, write([host()])),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(getMergedSurface({ tenantId: 'acme' }, store, RUN)).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    expect(store.models.size).toBe(0);
  });
});

describe('observability', () => {
  it('counts new nodes per type and wraps each merge in the surface.merge span', async () => {
    const increment = vi.fn();
    const spans: string[] = [];
    const withSpan = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      spans.push(name);
      return fn();
    };
    const store = memoryStore();
    await mergeSurfaceWrite(
      ctx({ increment, withSpan }),
      store,
      write([host(), tech('1.0'), endpoint('https://www.a.example/a')]),
    );
    expect(spans).toEqual([SURFACE_MERGE_SPAN]);
    expect(increment).toHaveBeenCalledWith(SURFACE_NODES_METRIC, { type: 'host' }, 1);
    expect(increment).toHaveBeenCalledWith(SURFACE_NODES_METRIC, { type: 'technology' }, 1);
    expect(increment).toHaveBeenCalledWith(SURFACE_NODES_METRIC, { type: 'endpoint' }, 1);
  });

  it('a replay increments nothing', async () => {
    const increment = vi.fn();
    const store = memoryStore();
    await mergeSurfaceWrite(ctx({ increment }), store, write([host()]));
    increment.mockClear();
    await mergeSurfaceWrite(ctx({ increment }), store, write([host()]));
    expect(increment).not.toHaveBeenCalled();
  });
});
