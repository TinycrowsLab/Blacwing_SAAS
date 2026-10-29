import { describe, expect, it } from 'vitest';

import { surfaceRunViewSchema } from './surface-view.js';

const NODE = {
  id: 'host:018f2a6e-1c00-7000-8000-00000000000a:api.example.test',
  kind: 'host',
  label: 'api.example.test',
  inScope: true,
  confidence: 0.9,
  degree: 1,
};

const VIEW = {
  nodes: [NODE],
  edges: [{ kind: 'EXPOSES', from: NODE.id, to: NODE.id }],
  totals: { nodes: 1, edges: 1 },
  truncated: false,
  pageInfo: { hasNextPage: false },
  clusteredBy: 'asset',
  runState: 'recon',
};

describe('surface run view contract', () => {
  it('accepts a well-formed view', () => {
    expect(surfaceRunViewSchema.safeParse(VIEW).success).toBe(true);
  });

  it('rejects a field outside the view, so raw graph properties never reach the wire', () => {
    const leaked = { ...VIEW, nodes: [{ ...NODE, banner: 'nginx 1.25' }] };
    expect(surfaceRunViewSchema.safeParse(leaked).success).toBe(false);
  });

  it('rejects a layout hint other than the asset cluster', () => {
    expect(surfaceRunViewSchema.safeParse({ ...VIEW, clusteredBy: 'host' }).success).toBe(false);
  });

  it('rejects a confidence outside [0, 1] and a negative degree', () => {
    expect(
      surfaceRunViewSchema.safeParse({ ...VIEW, nodes: [{ ...NODE, confidence: 1.5 }] }).success,
    ).toBe(false);
    expect(
      surfaceRunViewSchema.safeParse({ ...VIEW, nodes: [{ ...NODE, degree: -1 }] }).success,
    ).toBe(false);
  });

  it('rejects an unknown run state', () => {
    expect(surfaceRunViewSchema.safeParse({ ...VIEW, runState: 'exploded' }).success).toBe(false);
  });
});
