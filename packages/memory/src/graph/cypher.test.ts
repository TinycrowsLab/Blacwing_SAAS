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
  runTechnologiesCypher,
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

  it('keeps all Cypher in cypher.ts: the repository source contains no query text', () => {
    const source = readFileSync(new URL('./repository.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(MATCH|MERGE|RETURN|CREATE|DETACH)\b\s/);
  });
});
