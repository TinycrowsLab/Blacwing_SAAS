import { describe, expect, it } from 'vitest';

import {
  SURFACE_NODE_KINDS,
  type SurfaceEdgeView,
  type SurfaceNodeView,
  type SurfaceRunView,
} from '@blackwing/contracts';

import {
  DEFAULT_SURFACE_FILTERS,
  SURFACE_KIND_TOKENS,
  SURFACE_PAGE_LIMIT,
  confidencePercent,
  hasActiveFilters,
  isKindSelected,
  mergeSurfacePages,
  nodeWeight,
  parseSurfaceFilters,
  quantiseConfidence,
  surfaceFiltersToSearch,
  surfaceQueryParams,
  toggleSurfaceKind,
  truncationMessage,
} from './surface-view';

const RUN = '018f2a6e-1c00-7000-8000-000000000001';

function node(id: string, degree = 0): SurfaceNodeView {
  return {
    id,
    kind: 'host',
    label: id,
    confidence: 0.9,
    degree,
    provenance: {
      runId: RUN,
      firstSeenAt: '2026-10-29T10:00:00.000Z',
      lastSeenAt: '2026-10-29T10:05:00.000Z',
    },
  };
}

function edge(from: string, to: string): SurfaceEdgeView {
  return { kind: 'EXPOSES', from, to };
}

function page(
  nodes: SurfaceNodeView[],
  edges: SurfaceEdgeView[],
  extra: Partial<SurfaceRunView> = {},
): SurfaceRunView {
  return {
    nodes,
    edges,
    totals: { nodes: nodes.length, edges: edges.length },
    truncated: false,
    pageInfo: { hasNextPage: false },
    clusteredBy: 'asset',
    runState: 'recon',
    ...extra,
  };
}

describe('surface filters in the URL', () => {
  it('reads kinds, a confidence floor and the scope switch, and drops anything it does not understand', () => {
    const filters = parseSurfaceFilters(
      new URLSearchParams('kinds=host,database,host,service&minConfidence=0.42&inScopeOnly=true'),
    );
    expect(filters).toEqual({ kinds: ['host', 'service'], minConfidence: 0.4, inScopeOnly: true });
  });

  it.each([
    ['a confidence above 1', 'minConfidence=7', 1],
    ['a negative confidence', 'minConfidence=-3', 0],
    ['a non-numeric confidence', 'minConfidence=high', 0],
    ['an empty confidence', 'minConfidence=', 0],
  ])('clamps or ignores %s', (_name, query, expected) => {
    expect(parseSurfaceFilters(new URLSearchParams(query)).minConfidence).toBe(expected);
  });

  it('treats a scope flag other than the literal true as off', () => {
    expect(parseSurfaceFilters(new URLSearchParams('inScopeOnly=1')).inScopeOnly).toBe(false);
    expect(parseSurfaceFilters(new URLSearchParams('inScopeOnly=TRUE')).inScopeOnly).toBe(false);
  });

  it('stores every kind selected as the empty list, which the server reads as no kind filter', () => {
    const all = SURFACE_NODE_KINDS.join(',');
    expect(parseSurfaceFilters(new URLSearchParams(`kinds=${all}`)).kinds).toEqual([]);
  });

  it('writes only non-default filters, so the plain page keeps a clean URL', () => {
    expect(surfaceFiltersToSearch(DEFAULT_SURFACE_FILTERS)).toBe('');
    expect(
      surfaceFiltersToSearch({ kinds: ['host', 'service'], minConfidence: 0.4, inScopeOnly: true }),
    ).toBe('?kinds=host%2Cservice&minConfidence=0.4&inScopeOnly=true');
  });

  it('round-trips a filter state through the URL', () => {
    const filters = {
      kinds: ['endpoint', 'parameter'] as const,
      minConfidence: 0.55,
      inScopeOnly: false,
    };
    const search = surfaceFiltersToSearch({ ...filters, kinds: [...filters.kinds] });
    expect(parseSurfaceFilters(new URLSearchParams(search))).toEqual({
      ...filters,
      kinds: [...filters.kinds],
    });
  });

  it('quantises confidence to the slider step and rejects non-finite input', () => {
    expect(quantiseConfidence(0.333)).toBe(0.35);
    expect(quantiseConfidence(Number.NaN)).toBe(0);
    expect(quantiseConfidence(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('shows a confidence as a whole percentage', () => {
    expect(confidencePercent(0.35)).toBe(35);
    expect(confidencePercent(1)).toBe(100);
  });

  it('reports whether any filter narrows the surface', () => {
    expect(hasActiveFilters(DEFAULT_SURFACE_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_SURFACE_FILTERS, inScopeOnly: true })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_SURFACE_FILTERS, minConfidence: 0.1 })).toBe(true);
  });
});

describe('kind toggles', () => {
  it('shows every kind as pressed when no kind list is set', () => {
    for (const kind of SURFACE_NODE_KINDS)
      expect(isKindSelected(DEFAULT_SURFACE_FILTERS, kind)).toBe(true);
  });

  it('turning one kind off from "every kind" keeps the rest', () => {
    const next = toggleSurfaceKind(DEFAULT_SURFACE_FILTERS, 'service');
    expect(next.kinds).not.toContain('service');
    expect(next.kinds).toHaveLength(SURFACE_NODE_KINDS.length - 1);
    expect(isKindSelected(next, 'service')).toBe(false);
  });

  it('refuses to turn off the last kind, which would silently widen to every kind', () => {
    const one = { ...DEFAULT_SURFACE_FILTERS, kinds: ['host' as const] };
    expect(toggleSurfaceKind(one, 'host')).toEqual(one);
  });

  it('returns to the empty list once every kind is back on', () => {
    const minusOne = toggleSurfaceKind(DEFAULT_SURFACE_FILTERS, 'role');
    expect(toggleSurfaceKind(minusOne, 'role').kinds).toEqual([]);
  });
});

describe('query parameters of one page', () => {
  it('asks for a full page, the filters, and the scope flag as a string', () => {
    expect(surfaceQueryParams(DEFAULT_SURFACE_FILTERS, undefined)).toEqual({
      minConfidence: 0,
      inScopeOnly: 'false',
      limit: SURFACE_PAGE_LIMIT,
      cursor: undefined,
    });
  });

  it('sends the kinds, the floor and the cursor of the next page', () => {
    expect(
      surfaceQueryParams(
        { kinds: ['host', 'service'], minConfidence: 0.3, inScopeOnly: true },
        'host:abc',
      ),
    ).toEqual({
      kinds: 'host,service',
      minConfidence: 0.3,
      inScopeOnly: 'true',
      limit: SURFACE_PAGE_LIMIT,
      cursor: 'host:abc',
    });
  });
});

describe('merging pages of one filter state', () => {
  it('keeps each node once, the first copy, and joins the edges', () => {
    const merged = mergeSurfacePages([
      page([node('h1', 1), node('h2', 1)], [edge('h1', 'h2')]),
      page([node('h3', 0), node('h2', 9)], [edge('h3', 'h2')]),
    ]);
    expect(merged.nodes.map((n) => n.id)).toEqual(['h1', 'h2', 'h3']);
    expect(merged.nodes[1]?.degree).toBe(1);
    expect(merged.edges).toHaveLength(2);
  });

  it('drops an edge whose end is not in the merged set, so nothing dangles', () => {
    const merged = mergeSurfacePages([page([node('h1')], [edge('h1', 'ghost')])]);
    expect(merged.edges).toEqual([]);
  });

  it('keeps distinct edge kinds between the same two nodes', () => {
    const merged = mergeSurfacePages([
      page([node('a'), node('b')], [edge('a', 'b'), { kind: 'RUNS', from: 'a', to: 'b' }]),
    ]);
    expect(merged.edges).toHaveLength(2);
  });

  it('merges no pages into an empty surface', () => {
    expect(mergeSurfacePages([])).toEqual({ nodes: [], edges: [] });
  });
});

describe('presentation', () => {
  it('sizes a node by its degree, never below one', () => {
    expect(nodeWeight(0)).toBe(1);
    expect(nodeWeight(4)).toBe(5);
    expect(nodeWeight(-2)).toBe(1);
  });

  it('colours every kind from a design token, and never with the kill red reserved for the Kill control', () => {
    for (const kind of SURFACE_NODE_KINDS) {
      expect(SURFACE_KIND_TOKENS[kind]).toMatch(/^--[a-z-]+$/);
      expect(SURFACE_KIND_TOKENS[kind]).not.toBe('--kill');
    }
  });

  it('words the truncation banner with the shown and the total node counts', () => {
    expect(truncationMessage(2000, 5312)).toBe('Showing the 2000 most relevant nodes of 5312');
  });
});
