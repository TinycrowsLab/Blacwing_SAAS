import { describe, expect, it } from 'vitest';

import { surfaceRunViewSchema } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

import {
  auditRecorder,
  cursors,
  FakeGraph,
  host,
  key,
  metrics,
  OTHER_TENANT,
  OTHER_USER,
  principal,
  RUN,
  runRecord,
  service,
  surfaceOf,
  TENANT,
  USER,
} from './fixtures.test-helpers.js';
import { createCedarSurfacePolicy } from './policy.js';
import { RUN_SURFACE_VIEWED_ACTION, SurfaceService } from './service.js';

import type { SurfaceRunRecord, SurfaceRunReader } from './ports.js';

const policy = createCedarSurfacePolicy();

function runs(record: SurfaceRunRecord | null): SurfaceRunReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getRun: (tenantId) => {
      calls.push(tenantId);
      return Promise.resolve(record);
    },
  };
}

function build(
  options: {
    graph?: FakeGraph;
    record?: SurfaceRunRecord | null;
    nodeCap?: number;
    edgeCap?: number;
  } = {},
) {
  const graph = options.graph ?? new FakeGraph(surfaceOf([]));
  const audit = auditRecorder();
  const runReader = runs(options.record === undefined ? runRecord() : options.record);
  const m = metrics();
  const service = new SurfaceService({
    runs: runReader,
    graph,
    policy,
    audit: audit.write,
    cursors: cursors(),
    metrics: m,
    ...(options.nodeCap === undefined ? {} : { nodeCap: options.nodeCap }),
    ...(options.edgeCap === undefined ? {} : { edgeCap: options.edgeCap }),
  });
  return { service, graph, audit, runReader, metrics: m };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).code;
}

const hub = host('hub.example.test');
const ssh = service('hub.example.test', 22);
const web = service('hub.example.test', 443);

describe('surface view: refusals happen before any graph read', () => {
  it('refuses a caller with no tenant context (TENANT_CONTEXT_MISSING)', async () => {
    const { service, graph } = build();
    expect(await codeOf(service.get(principal(undefined, { tenantId: null }), RUN, {}))).toBe(
      'TENANT_CONTEXT_MISSING',
    );
    expect(graph.calls).toHaveLength(0);
  });

  it('refuses a malformed run id (VALIDATION_FAILED)', async () => {
    const { service, graph } = build();
    expect(await codeOf(service.get(principal(), 'not-a-uuid', {}))).toBe('VALIDATION_FAILED');
    expect(graph.calls).toHaveLength(0);
  });

  it('refuses an invalid query (INVALID_QUERY) before the run lookup', async () => {
    const { service, runReader, graph } = build();
    expect(await codeOf(service.get(principal(), RUN, { limit: '500' }))).toBe('INVALID_QUERY');
    expect(runReader.calls).toHaveLength(0);
    expect(graph.calls).toHaveLength(0);
  });

  it('refuses a caller without run:read (FORBIDDEN), without revealing the run', async () => {
    const { service, runReader, graph } = build();
    expect(await codeOf(service.get(principal([]), RUN, {}))).toBe('FORBIDDEN');
    expect(runReader.calls).toHaveLength(0);
    expect(graph.calls).toHaveLength(0);
  });

  it('answers RUN_NOT_FOUND for a run that does not exist in the tenant', async () => {
    const { service, graph } = build({ record: null });
    expect(await codeOf(service.get(principal(), RUN, {}))).toBe('RUN_NOT_FOUND');
    expect(graph.calls).toHaveLength(0);
  });

  it('answers the same RUN_NOT_FOUND for a run that belongs to another tenant (no existence oracle)', async () => {
    const { service, graph } = build({ record: runRecord({ tenantId: OTHER_TENANT }) });
    expect(await codeOf(service.get(principal(), RUN, {}))).toBe('RUN_NOT_FOUND');
    expect(graph.calls).toHaveLength(0);
  });

  it('refuses an asset owner who does not own the run asset (Cedar, FORBIDDEN)', async () => {
    const { service, graph, audit } = build({
      record: runRecord({ ownerUserIds: [OTHER_USER] }),
    });
    expect(await codeOf(service.get(principal(['asset_owner']), RUN, {}))).toBe('FORBIDDEN');
    expect(graph.calls).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });
});

describe('surface view: the served view', () => {
  it('serves nodes with labels, degree and confidence, and edges between them', async () => {
    const graph = new FakeGraph(
      surfaceOf(
        [
          { node: hub, degree: 2 },
          { node: ssh, degree: 1 },
          { node: web, degree: 1 },
        ],
        {
          edges: [
            { kind: 'EXPOSES', fromKey: key(hub), toKey: key(ssh) },
            { kind: 'EXPOSES', fromKey: key(hub), toKey: key(web) },
          ],
        },
      ),
    );
    const { service } = build({ graph });
    const view = await service.get(principal(), RUN, {});

    expect(view.nodes).toEqual([
      {
        id: key(hub),
        kind: 'host',
        label: 'hub.example.test',
        inScope: true,
        confidence: 0.9,
        degree: 2,
      },
      {
        id: key(ssh),
        kind: 'service',
        label: 'hub.example.test:22/tcp',
        confidence: 0.9,
        degree: 1,
      },
      {
        id: key(web),
        kind: 'service',
        label: 'hub.example.test:443/tcp',
        confidence: 0.9,
        degree: 1,
      },
    ]);
    expect(view.edges).toEqual([
      { kind: 'EXPOSES', from: key(hub), to: key(ssh) },
      { kind: 'EXPOSES', from: key(hub), to: key(web) },
    ]);
    expect(view.totals).toEqual({ nodes: 3, edges: 2 });
    expect(view.truncated).toBe(false);
    expect(view.clusteredBy).toBe('asset');
    expect(view.runState).toBe('recon');
    expect(view.pageInfo.hasNextPage).toBe(false);
    expect(view.pageInfo.endCursor).toBeDefined();
    expect(surfaceRunViewSchema.safeParse(view).success).toBe(true);
  });

  it('answers an empty surface with empty arrays and no truncation', async () => {
    const { service } = build({ graph: new FakeGraph(surfaceOf([])) });
    const view = await service.get(principal(), RUN, {});
    expect(view).toEqual({
      nodes: [],
      edges: [],
      totals: { nodes: 0, edges: 0 },
      truncated: false,
      pageInfo: { hasNextPage: false },
      clusteredBy: 'asset',
      runState: 'recon',
    });
  });

  it('never returns an edge whose end is not in the page (no dangling reference)', async () => {
    const stranger = host('elsewhere.example.test');
    const graph = new FakeGraph(
      surfaceOf([{ node: hub, degree: 1 }], {
        edges: [{ kind: 'EXPOSES', fromKey: key(hub), toKey: key(stranger) }],
      }),
    );
    const { service } = build({ graph });
    const view = await service.get(principal(), RUN, {});
    expect(view.edges).toEqual([]);
  });

  it('keeps a finished run viewable and reports its state', async () => {
    const { service } = build({
      record: runRecord({ state: 'killed' }),
      graph: new FakeGraph(surfaceOf([{ node: hub, degree: 0 }])),
    });
    expect((await service.get(principal(), RUN, {})).runState).toBe('killed');
  });

  it('forwards kinds, the confidence floor and the default page size to the graph', async () => {
    const { service, graph } = build();
    await service.get(principal(), RUN, { kinds: 'host,service', minConfidence: '0.4' });
    expect(graph.calls[0]?.query).toEqual({
      kinds: ['host', 'service'],
      minConfidence: 0.4,
      limit: 100,
      nodeCap: 2000,
      edgeCap: 4000,
    });
    expect(graph.calls[0]?.tenantId).toBe(TENANT);
    expect(graph.calls[0]?.runId).toBe(RUN);
  });
});

describe('surface view: caps and truncation', () => {
  it('reports truncation with full totals when the surface exceeds the node cap', async () => {
    const kept = [
      { node: hub, degree: 3 },
      { node: ssh, degree: 1 },
    ];
    const graph = new FakeGraph(surfaceOf(kept, { totals: { nodes: 2500, edges: 2600 } }));
    const { service, metrics } = build({ graph });
    const view = await service.get(principal(), RUN, { limit: '200' });

    expect(view.truncated).toBe(true);
    expect(view.nodes.length).toBeLessThanOrEqual(2000);
    expect(view.totals).toEqual({ nodes: 2500, edges: 2600 });
    expect((await metrics.truncated.get()).values[0]?.value).toBe(1);
  });

  it('reports truncation when the surface exceeds the edge cap, and the page edges are cut', async () => {
    const graph = new FakeGraph(surfaceOf([{ node: hub, degree: 1 }], { edgesTruncated: true }));
    const { service } = build({ graph });
    expect((await service.get(principal(), RUN, {})).truncated).toBe(true);
  });

  it('applies a smaller configured cap to the query it sends', async () => {
    const { service, graph } = build({ nodeCap: 5, edgeCap: 7 });
    await service.get(principal(), RUN, {});
    expect(graph.calls[0]?.query).toMatchObject({ nodeCap: 5, edgeCap: 7 });
  });

  it('reports truncation when the total is over a small configured cap', async () => {
    const graph = new FakeGraph(
      surfaceOf([{ node: hub, degree: 1 }], { totals: { nodes: 6, edges: 0 } }),
    );
    const { service } = build({ graph, nodeCap: 5 });
    expect((await service.get(principal(), RUN, {})).truncated).toBe(true);
  });
});

describe('surface view: pagination', () => {
  it('returns the last node as endCursor and continues after it with that cursor', async () => {
    const graph = new FakeGraph((query) =>
      query.after === undefined
        ? surfaceOf([{ node: hub, degree: 1 }], {
            totals: { nodes: 2, edges: 0 },
            nextCursor: key(hub),
          })
        : surfaceOf([{ node: ssh, degree: 0 }], { totals: { nodes: 2, edges: 0 } }),
    );
    const { service } = build({ graph });
    const first = await service.get(principal(), RUN, { limit: '1' });
    expect(first.pageInfo.hasNextPage).toBe(true);
    expect(first.pageInfo.endCursor).toBeDefined();

    const second = await service.get(principal(), RUN, {
      limit: '1',
      cursor: first.pageInfo.endCursor ?? '',
    });
    expect(graph.calls[1]?.query.after).toBe(key(hub));
    expect(second.nodes.map((node) => node.id)).toEqual([key(ssh)]);
    expect(second.pageInfo.hasNextPage).toBe(false);
  });

  it('refuses a cursor issued for another run (INVALID_CURSOR)', async () => {
    const { service } = build({
      graph: new FakeGraph(surfaceOf([{ node: hub, degree: 1 }], { nextCursor: key(hub) })),
    });
    const view = await service.get(principal(), RUN, { limit: '1' });
    const other = '018f2a6e-1c01-7000-8000-0000000000ff';
    expect(
      await codeOf(service.get(principal(), other, { cursor: view.pageInfo.endCursor ?? '' })),
    ).toBe('INVALID_CURSOR');
  });

  it('refuses a cursor for another filter (INVALID_CURSOR)', async () => {
    const { service } = build({
      graph: new FakeGraph(surfaceOf([{ node: hub, degree: 1 }], { nextCursor: key(hub) })),
    });
    const view = await service.get(principal(), RUN, { limit: '1' });
    expect(
      await codeOf(
        service.get(principal(), RUN, { kinds: 'service', cursor: view.pageInfo.endCursor ?? '' }),
      ),
    ).toBe('INVALID_CURSOR');
  });

  it('refuses a forged cursor (INVALID_CURSOR)', async () => {
    const { service } = build();
    expect(await codeOf(service.get(principal(), RUN, { cursor: 'forged.cursor' }))).toBe(
      'INVALID_CURSOR',
    );
  });
});

describe('surface view: audit and tenant isolation', () => {
  it('records one run.surface.viewed event for the caller, in the caller tenant', async () => {
    const { service, audit } = build();
    await service.get(principal(), RUN, {});
    expect(audit.events).toEqual([
      {
        tenantId: TENANT,
        action: RUN_SURFACE_VIEWED_ACTION,
        actor: { type: 'user', id: USER },
        target: { type: 'run', id: RUN },
        outcome: 'success',
        runId: RUN,
      },
    ]);
  });

  it('records a service account as the service actor', async () => {
    const { service, audit } = build();
    await service.get(principal(['appsec_engineer'], { type: 'service' }), RUN, {});
    expect(audit.events[0]?.actor).toEqual({ type: 'service', id: USER });
  });

  it('fails the read when the audit write fails (fail closed, no view served)', async () => {
    const graph = new FakeGraph(surfaceOf([{ node: hub, degree: 0 }]));
    const runReader = runs(runRecord());
    const service = new SurfaceService({
      runs: runReader,
      graph,
      policy,
      audit: () => Promise.reject(new Error('ledger down')),
      cursors: cursors(),
      metrics: metrics(),
    });
    await expect(service.get(principal(), RUN, {})).rejects.toThrow('ledger down');
  });

  it('reads the run and the graph only in the caller tenant', async () => {
    const { service, runReader, graph } = build();
    await service.get(principal(), RUN, {});
    expect(runReader.calls).toEqual([TENANT]);
    expect(graph.calls.map((call) => call.tenantId)).toEqual([TENANT]);
  });
});
