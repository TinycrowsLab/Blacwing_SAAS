// Unit: the static §8.6 guard. Every Cypher template the repository can send must bind `$tenantId`, and all Cypher
// lives in cypher.ts so this scan sees all of it.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SURFACE_EDGE_KINDS, SURFACE_NODE_KINDS } from '@blackwing/contracts';

import {
  countNodesCypher,
  getNodeCypher,
  listNodesCypher,
  mergeEdgeCypher,
  mergeNodeCypher,
  neighboursCypher,
  runEdgeCountsCypher,
  runEndpointsCypher,
  runEndpointTotalsCypher,
  runNodeCountsCypher,
  runSurfaceEdgeCountCypher,
  runSurfaceEdgesCypher,
  runSurfaceNodeCountCypher,
  runSurfaceRankedCypher,
  runTechnologiesCypher,
  upsertEdgesCypher,
  upsertNodesCypher,
  upsertStubsCypher,
} from './cypher.js';

describe('Cypher templates bind $tenantId', () => {
  it.each(SURFACE_NODE_KINDS)('every node template for %s references $tenantId', (kind) => {
    for (const template of [
      mergeNodeCypher(kind),
      getNodeCypher(kind),
      listNodesCypher(kind),
      countNodesCypher(kind),
    ]) {
      expect(template).toContain('$tenantId');
    }
  });

  it.each(SURFACE_EDGE_KINDS)('the edge template for %s references $tenantId', (kind) => {
    expect(mergeEdgeCypher(kind)).toContain('$tenantId');
  });

  it('the neighbourhood template pins every hop and the depth to the tenant and a bound depth', () => {
    expect(neighboursCypher(1)).toContain('$tenantId');
    expect(neighboursCypher(2)).toContain('*1..2');
  });

  it.each([
    ['run node counts', runNodeCountsCypher()],
    ['run edge counts', runEdgeCountsCypher()],
    ['run technologies', runTechnologiesCypher()],
    ['run endpoint totals', runEndpointTotalsCypher()],
    ['run endpoints', runEndpointsCypher()],
  ])('the %s template references $tenantId and filters on the run', (_name, cypher) => {
    expect(cypher).toContain('$tenantId');
    expect(cypher).toMatch(/provenance_runId|\$runId/);
  });

  it('every run-surface template binds $tenantId and the run', () => {
    for (const template of [
      runSurfaceNodeCountCypher(),
      runSurfaceEdgeCountCypher(),
      runSurfaceRankedCypher(),
      runSurfaceEdgesCypher(),
    ]) {
      expect(template).toContain('$tenantId');
      expect(template).toContain('$runId');
    }
  });

  it('applies the in-scope filter to every run-surface template, so it is enforced in the graph', () => {
    for (const template of [
      runSurfaceNodeCountCypher(),
      runSurfaceEdgeCountCypher(),
      runSurfaceRankedCypher(),
    ]) {
      expect(template).toContain('NOT $inScopeOnly OR');
      expect(template).toContain('.inScope IS NULL OR');
    }
  });

  it('ranks and caps the run surface in Cypher, not in application code', () => {
    const ranked = runSurfaceRankedCypher();
    expect(ranked).toContain('count(r) AS degree');
    expect(ranked).toContain('ORDER BY degree DESC');
    expect(ranked).toContain('LIMIT $nodeCap');
  });

  it('keeps all Cypher in cypher.ts: the repository source contains no query text', () => {
    const source = readFileSync(new URL('./repository.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(MATCH|MERGE|RETURN|CREATE|DETACH)\b\s/);
  });
});

describe('upsert templates (GRAPH-007)', () => {
  it.each(SURFACE_NODE_KINDS)(
    'the node upsert and stub templates for %s bind $tenantId',
    (kind) => {
      expect(upsertNodesCypher(kind)).toContain('$tenantId');
      expect(upsertStubsCypher(kind)).toContain('$tenantId');
    },
  );

  it.each(SURFACE_EDGE_KINDS)('the edge upsert template for %s binds $tenantId', (kind) => {
    expect(upsertEdgesCypher(kind)).toContain('$tenantId');
  });

  it('merges by natural key in a batch, never by interpolated values', () => {
    const cypher = upsertNodesCypher('host');
    expect(cypher.startsWith('UNWIND $rows AS row')).toBe(true);
    expect(cypher).toContain('MERGE (n:Host {tenantId: $tenantId, naturalKey: row.naturalKey})');
  });

  it('keeps the larger confidence and the lexically larger lastSeenAt, and never touches firstSeenAt', () => {
    const cypher = upsertNodesCypher('endpoint');
    expect(cypher).toContain('WHEN row.confidence > oldConfidence THEN row.confidence');
    expect(cypher).toContain('WHEN row.lastSeenAt > oldLastSeenAt THEN row.lastSeenAt');
    expect(cypher).not.toContain('provenance_firstSeenAt = ');
  });

  it('records the run and one observation per (run, natural key, tool)', () => {
    const cypher = upsertNodesCypher('endpoint');
    expect(cypher).toContain('MERGE (n)-[:OBSERVED_IN]->(run)');
    expect(cypher).toContain(
      'MERGE (o:Observation {tenantId: $tenantId, observationKey: row.observationKey})',
    );
  });

  it('creates a stub with the stub flag and zero confidence only when the node is absent', () => {
    const cypher = upsertStubsCypher('host');
    expect(cypher).toContain('ON CREATE SET n.stub = true');
    expect(cypher).toContain('n.provenance_confidence = 0.0');
  });

  it('hides placeholder stubs from every node read and node count', () => {
    const live = 'coalesce(n.stub, false) = false';
    expect(getNodeCypher('host')).toContain(live);
    expect(listNodesCypher('host')).toContain(live);
    expect(countNodesCypher('host')).toContain(live);
    expect(neighboursCypher(1)).toContain(live);
    expect(runEndpointsCypher()).toContain(live);
    expect(runSurfaceRankedCypher()).toContain(live);
    expect(runNodeCountsCypher()).toContain(live);
    expect(runEndpointTotalsCypher()).toContain('coalesce(e.stub, false) = false');
  });
});
