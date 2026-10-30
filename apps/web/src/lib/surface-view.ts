import {
  SURFACE_NODE_KINDS,
  type SurfaceNodeKind,
  type SurfaceNodeView,
  type SurfaceEdgeView,
  type SurfaceRunView,
} from '@blackwing/contracts';

// The surface explorer's model (GRAPH-006 view, console page): the filter state that lives in the URL, the query
// it sends, the merge of its pages, and the presentation of a node. Pure functions, so the page and its tests share
// one definition. The server does every selection (kinds, confidence, scope, the node cap); the client only
// presents what it received.

/** Nodes asked for per page: the largest page the view serves (GRAPH_VIZ_MAX_LIMIT). */
export const SURFACE_PAGE_LIMIT = 200;

/** Filter state of the explorer. An empty `kinds` means every kind, the same meaning the server gives an absent list. */
export interface SurfaceFilters {
  readonly kinds: readonly SurfaceNodeKind[];
  /** Keep nodes and edges at least this confident (0 to 1, two decimals in the URL). */
  readonly minConfidence: number;
  readonly inScopeOnly: boolean;
}

export const DEFAULT_SURFACE_FILTERS: SurfaceFilters = {
  kinds: [],
  minConfidence: 0,
  inScopeOnly: false,
};

const CONFIDENCE_STEP = 0.05;
const CONFIDENCE_DECIMALS = 2;

/** Rounds a confidence to the slider step and two decimals, so the URL and the query stay canonical. */
export function quantiseConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(1, Math.max(0, value));
  const stepped = Math.round(clamped / CONFIDENCE_STEP) * CONFIDENCE_STEP;
  return Number(stepped.toFixed(CONFIDENCE_DECIMALS));
}

function isNodeKind(value: string): value is SurfaceNodeKind {
  return (SURFACE_NODE_KINDS as readonly string[]).includes(value);
}

/**
 * Reads the filter state from the URL (`?kinds=host,service&minConfidence=0.4&inScopeOnly=true`). Unknown kinds and
 * out-of-range or non-numeric confidences are dropped, never sent: the URL is user input and the server re-checks it.
 */
export function parseSurfaceFilters(params: URLSearchParams): SurfaceFilters {
  const kinds: SurfaceNodeKind[] = [];
  for (const name of (params.get('kinds') ?? '').split(',')) {
    const trimmed = name.trim();
    if (isNodeKind(trimmed) && !kinds.includes(trimmed)) kinds.push(trimmed);
  }
  const raw = params.get('minConfidence');
  const parsed = raw === null || raw.trim() === '' ? 0 : Number(raw);
  const inScopeRaw = params.get('inScopeOnly');
  return {
    // Every kind selected is the same as no kind filter, so it is stored as the empty list.
    kinds: kinds.length === SURFACE_NODE_KINDS.length ? [] : kinds,
    minConfidence: quantiseConfidence(parsed),
    inScopeOnly: inScopeRaw === 'true',
  };
}

/** The URL query for a filter state. Defaults are omitted, so the plain page has a clean URL. */
export function surfaceFiltersToSearch(filters: SurfaceFilters): string {
  const params = new URLSearchParams();
  if (filters.kinds.length > 0) params.set('kinds', filters.kinds.join(','));
  if (filters.minConfidence > 0) params.set('minConfidence', String(filters.minConfidence));
  if (filters.inScopeOnly) params.set('inScopeOnly', 'true');
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

/** True when any filter narrows the surface, for the empty-state copy. */
export function hasActiveFilters(filters: SurfaceFilters): boolean {
  return filters.kinds.length > 0 || filters.minConfidence > 0 || filters.inScopeOnly;
}

/** Whether a kind toggle is pressed: no kind list means every kind is shown. */
export function isKindSelected(filters: SurfaceFilters, kind: SurfaceNodeKind): boolean {
  return filters.kinds.length === 0 || filters.kinds.includes(kind);
}

/**
 * The filter state after toggling one kind. Turning a kind off from "every kind" starts from the full list. The last
 * kind left on cannot be turned off, since an empty selection would silently widen to every kind.
 */
export function toggleSurfaceKind(filters: SurfaceFilters, kind: SurfaceNodeKind): SurfaceFilters {
  const current = filters.kinds.length === 0 ? [...SURFACE_NODE_KINDS] : [...filters.kinds];
  const next = current.includes(kind)
    ? current.filter((name) => name !== kind)
    : [...current, kind];
  if (next.length === 0) return filters;
  const kinds = SURFACE_NODE_KINDS.filter((name) => next.includes(name));
  return { ...filters, kinds: kinds.length === SURFACE_NODE_KINDS.length ? [] : kinds };
}

/** The query parameters of one page request. The client never sends a tenant: the BFF session carries it. */
export function surfaceQueryParams(
  filters: SurfaceFilters,
  cursor: string | undefined,
): Record<string, string | number | undefined> {
  return {
    ...(filters.kinds.length > 0 ? { kinds: filters.kinds.join(',') } : {}),
    minConfidence: filters.minConfidence,
    inScopeOnly: filters.inScopeOnly ? 'true' : 'false',
    limit: SURFACE_PAGE_LIMIT,
    cursor,
  };
}

/** The graph the canvas draws, merged from every page loaded for one filter state. */
export interface MergedSurface {
  readonly nodes: readonly SurfaceNodeView[];
  readonly edges: readonly SurfaceEdgeView[];
}

/**
 * Joins the pages of one filter state. Pages hold disjoint nodes (keyset order), so a repeated node keeps its first
 * copy. The view returns only edges between nodes of the same page, so an edge that names a node outside the merged
 * set is dropped rather than left dangling.
 */
export function mergeSurfacePages(pages: readonly SurfaceRunView[]): MergedSurface {
  const nodes = new Map<string, SurfaceNodeView>();
  for (const page of pages) {
    for (const node of page.nodes) {
      if (!nodes.has(node.id)) nodes.set(node.id, node);
    }
  }
  const edges = new Map<string, SurfaceEdgeView>();
  for (const page of pages) {
    for (const edge of page.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
      edges.set(`${edge.kind}|${edge.from}|${edge.to}`, edge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Node colour roles: one design token per kind, never a hard-coded hex. Kill red is reserved for the Kill control. */
export const SURFACE_KIND_TOKENS: Readonly<Record<SurfaceNodeKind, string>> = {
  asset: '--primary',
  host: '--success',
  service: '--sev-medium',
  technology: '--sev-info',
  endpoint: '--sev-low',
  parameter: '--warning',
  role: '--muted-foreground',
  spec_document: '--sev-info',
  schema_object: '--muted-foreground',
  auth_scheme: '--warning',
  source_route: '--sev-low',
  config_item: '--success',
};

/** Human label of a node kind, for chips and the inspector. */
export const SURFACE_KIND_LABELS: Readonly<Record<SurfaceNodeKind, string>> = {
  asset: 'Asset',
  host: 'Host',
  service: 'Service',
  technology: 'Technology',
  endpoint: 'Endpoint',
  parameter: 'Parameter',
  role: 'Role',
  spec_document: 'Spec document',
  schema_object: 'Schema object',
  auth_scheme: 'Auth scheme',
  source_route: 'Source route',
  config_item: 'Config item',
};

/** Node radius weight: size follows degree (edges to other nodes of the view), so hubs read as hubs. */
export function nodeWeight(degree: number): number {
  return 1 + Math.max(0, degree);
}

const PERCENT = 100;

/** A confidence in [0, 1] as a whole percentage, for display. */
export function confidencePercent(value: number): number {
  return Math.round(value * PERCENT);
}

/** The copy of the truncation banner. `shown` and `total` are nodes, `total` being the full surface count. */
export function truncationMessage(shown: number, total: number): string {
  return `Showing the ${String(shown)} most relevant nodes of ${String(total)}`;
}
