'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { SURFACE_NODE_KINDS, type SurfaceNodeKind } from '@blackwing/contracts';
import { LoadingState } from '@blackwing/ui';

import {
  nodeWeight,
  SURFACE_KIND_TOKENS,
  type MergedSurface,
} from '../../../../../../lib/surface-view';

/** Edge colour role; a design token like the node colours. */
const EDGE_TOKEN = '--border';
/** Warmup ticks laid out before the first paint when motion is reduced, so the graph appears settled, not animated. */
const REDUCED_MOTION_WARMUP_TICKS = 300;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// The graph library draws on a canvas and touches `window`, so it is loaded in the browser only (no hydration
// mismatch, and the bundle stays out of the first page load).
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false,
  loading: () => <LoadingState variant="card" label="Loading graph" />,
});

/** Canvas colours read from the design tokens at render time. Server render and no-CSS hosts get a system colour. */
function readTokens(names: readonly string[], fallback: string): ReadonlyMap<string, string> {
  if (typeof document === 'undefined') return new Map(names.map((name) => [name, fallback]));
  const style = getComputedStyle(document.documentElement);
  return new Map(names.map((name) => [name, style.getPropertyValue(name).trim() || fallback]));
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => {
      setReduced(query.matches);
    };
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);
  return reduced;
}

function useElementWidth<T extends HTMLElement>(): readonly [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => {
      setWidth(Math.floor(element.clientWidth));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

const CANVAS_HEIGHT = 560;

export interface SurfaceGraphProps {
  readonly surface: MergedSurface;
  readonly onSelect: (id: string) => void;
}

/**
 * The surface as a force-directed node-link graph. Nodes are coloured by kind and sized by degree; the layout clusters
 * connected nodes, and an asset's hosts, services and endpoints gather around it. Motion is off under
 * `prefers-reduced-motion`: the layout is computed up front and drawn settled.
 */
export function SurfaceGraph({ surface, onSelect }: SurfaceGraphProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const reducedMotion = usePrefersReducedMotion();

  const byId = useMemo(
    () => new Map(surface.nodes.map((node) => [node.id, node])),
    [surface.nodes],
  );

  const graphData = useMemo(
    () => ({
      nodes: surface.nodes.map((node) => ({ id: node.id })),
      links: surface.edges.map((edge) => ({ source: edge.from, target: edge.to })),
    }),
    [surface.nodes, surface.edges],
  );

  const colours = useMemo(
    () =>
      readTokens(
        [...SURFACE_NODE_KINDS.map((kind) => SURFACE_KIND_TOKENS[kind]), EDGE_TOKEN],
        'CanvasText',
      ),
    // Re-read on each new surface, so a theme switch shows on the next load.
    [surface.nodes],
  );

  const colourOf = (kind: SurfaceNodeKind | undefined): string =>
    colours.get(SURFACE_KIND_TOKENS[kind ?? 'role']) ?? 'CanvasText';

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-lg border border-border bg-card"
      style={{ height: CANVAS_HEIGHT }}
      role="img"
      aria-label={`Attack surface graph: ${String(surface.nodes.length)} nodes and ${String(surface.edges.length)} relationships. Select a node in the list to inspect it.`}
    >
      {width > 0 && (
        <ForceGraph2D
          graphData={graphData}
          width={width}
          height={CANVAS_HEIGHT}
          nodeRelSize={4}
          nodeVal={(node) => nodeWeight(byId.get(String(node.id))?.degree ?? 0)}
          nodeColor={(node) => colourOf(byId.get(String(node.id))?.kind)}
          linkColor={() => colours.get(EDGE_TOKEN) ?? 'CanvasText'}
          nodeLabel={(node) => byId.get(String(node.id))?.label ?? ''}
          onNodeClick={(node) => {
            onSelect(String(node.id));
          }}
          warmupTicks={reducedMotion ? REDUCED_MOTION_WARMUP_TICKS : 0}
          {...(reducedMotion ? { cooldownTicks: 0 } : {})}
        />
      )}
    </div>
  );
}
