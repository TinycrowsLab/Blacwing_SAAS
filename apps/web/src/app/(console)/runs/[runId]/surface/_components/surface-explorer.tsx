'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { surfaceRunViewSchema, type SurfaceNodeView } from '@blackwing/contracts';
import { Badge, QueryState } from '@blackwing/ui';

import { SurfaceFiltersPanel } from './surface-filters';
import { SurfaceGraph } from './surface-graph';
import { SurfaceInspector } from './surface-inspector';
import { createApiClient } from '../../../../../../lib/api-client';
import { isApiError } from '../../../../../../lib/api-error';
import { emitClientEvent } from '../../../../../../lib/client-events';
import { qk } from '../../../../../../lib/query-keys';
import {
  RUN_STATE_LABELS,
  RUN_STATE_TONES,
  isTerminalState,
} from '../../../../../../lib/run-states';
import {
  hasActiveFilters,
  mergeSurfacePages,
  parseSurfaceFilters,
  surfaceFiltersToSearch,
  surfaceQueryParams,
  truncationMessage,
  type SurfaceFilters,
} from '../../../../../../lib/surface-view';

const api = createApiClient();
const ROUTE = '/runs/[runId]/surface';

export interface SurfaceExplorerProps {
  readonly runId: string;
}

/**
 * The surface page's client half. The filter state lives in the URL, so a filtered view is shareable and survives a
 * reload; each change is a new query, and the server does the selection. Pages load until the view is complete (the
 * server caps the total), so the canvas never holds more than the view served.
 */
export function SurfaceExplorer({ runId }: SurfaceExplorerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = useMemo(
    () => parseSurfaceFilters(new URLSearchParams(params.toString())),
    [params],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const setFilters = useCallback(
    (next: SurfaceFilters) => {
      router.replace(`${pathname}${surfaceFiltersToSearch(next)}`, { scroll: false });
    },
    [pathname, router],
  );

  const query = useInfiniteQuery({
    queryKey: qk.surface(runId, {
      kinds: filters.kinds.join(','),
      minConfidence: filters.minConfidence,
      inScopeOnly: String(filters.inScopeOnly),
    }),
    queryFn: ({ pageParam, signal }) =>
      api.get(`/runs/${runId}/surface`, surfaceRunViewSchema, {
        query: surfaceQueryParams(filters, pageParam),
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? last.pageInfo.endCursor : undefined),
    meta: { suppressGlobalError: true },
  });

  // An ApiError keeps its status, so a 403 renders the permission-denied state; any other failure is generic.
  const failure = query.error === null ? null : isApiError(query.error) ? query.error : {};
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && failure === null) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, failure]);

  const pages = useMemo(() => query.data?.pages ?? [], [query.data]);
  const surface = useMemo(() => mergeSurfacePages(pages), [pages]);
  const first = pages[0];
  const total = first?.totals.nodes ?? 0;
  const truncated = first?.truncated ?? false;
  const runState = first?.runState;
  const selected: SurfaceNodeView | null =
    surface.nodes.find((node) => node.id === selectedId) ?? null;

  useEffect(() => {
    if (first !== undefined) emitClientEvent('surface_graph_rendered', ROUTE, { topic: 'surface' });
  }, [first]);

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)_280px]">
      <SurfaceFiltersPanel filters={filters} onChange={setFilters} />

      <div className="grid min-w-0 content-start gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {runState !== undefined && (
            <Badge variant={RUN_STATE_TONES[runState]} data-testid="surface-run-state">
              {RUN_STATE_LABELS[runState]}
            </Badge>
          )}
          {runState !== undefined && isTerminalState(runState) && (
            <p className="text-xs text-muted-foreground">
              This run has ended. The surface is its last-known state.
            </p>
          )}
        </div>

        {truncated && (
          <div
            role="status"
            data-testid="surface-truncation"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted px-4 py-2 text-sm"
          >
            <p>{truncationMessage(surface.nodes.length, total)}</p>
            <a href="#surface-filters" className="text-primary underline-offset-4 hover:underline">
              Narrow the filters
            </a>
          </div>
        )}

        <QueryState
          isPending={query.isPending}
          error={failure}
          isEmpty={surface.nodes.length === 0}
          empty={{
            title: 'No surface discovered yet',
            description: hasActiveFilters(filters)
              ? 'No nodes match these filters. Widen them to see more of the surface.'
              : 'Recon has not found any assets, hosts or endpoints for this run yet.',
          }}
          loadingVariant="detail"
          onRetry={() => {
            void query.refetch();
          }}
          isRetrying={query.isFetching && !query.isPending}
        >
          <SurfaceGraph
            surface={surface}
            onSelect={(id) => {
              setSelectedId(id);
            }}
          />
          <details className="mt-4 rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Node list ({String(surface.nodes.length)})
            </summary>
            <ul
              aria-label="Surface nodes"
              className="mt-3 grid max-h-72 gap-1 overflow-y-auto text-sm"
            >
              {surface.nodes.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    aria-pressed={node.id === selectedId}
                    onClick={() => {
                      setSelectedId(node.id);
                    }}
                    className="w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent"
                  >
                    {node.label}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </QueryState>
      </div>

      <SurfaceInspector node={selected} />
    </div>
  );
}
