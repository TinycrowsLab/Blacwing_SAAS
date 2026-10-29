'use client';

import { SURFACE_NODE_KINDS, type SurfaceNodeKind } from '@blackwing/contracts';
import { Button, cn } from '@blackwing/ui';

import {
  confidencePercent,
  DEFAULT_SURFACE_FILTERS,
  hasActiveFilters,
  isKindSelected,
  quantiseConfidence,
  SURFACE_KIND_LABELS,
  toggleSurfaceKind,
  type SurfaceFilters,
} from '../../../../../../lib/surface-view';

export interface SurfaceFiltersProps {
  readonly filters: SurfaceFilters;
  /** Called with the next filter state. The explorer writes it to the URL, which refetches server-side. */
  readonly onChange: (next: SurfaceFilters) => void;
}

/** Kind toggles, the confidence floor and the in-scope switch. Every control is a native, labelled control. */
export function SurfaceFiltersPanel({ filters, onChange }: SurfaceFiltersProps) {
  const percent = confidencePercent(filters.minConfidence);
  return (
    <section id="surface-filters" aria-labelledby="surface-filters-title" className="grid gap-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="surface-filters-title" className="text-sm font-semibold">
          Filters
        </h2>
        {hasActiveFilters(filters) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(DEFAULT_SURFACE_FILTERS);
            }}
          >
            Reset
          </Button>
        )}
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Node kinds</legend>
        <div className="flex flex-wrap gap-2">
          {SURFACE_NODE_KINDS.map((kind: SurfaceNodeKind) => {
            const pressed = isKindSelected(filters, kind);
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={pressed}
                onClick={() => {
                  onChange(toggleSurfaceKind(filters, kind));
                }}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  pressed
                    ? 'border-primary bg-accent text-accent-foreground'
                    : 'border-border bg-background text-muted-foreground',
                )}
              >
                {SURFACE_KIND_LABELS[kind]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-2">
        <label
          htmlFor="surface-min-confidence"
          className="text-xs font-medium text-muted-foreground"
        >
          Minimum confidence: {String(percent)}%
        </label>
        <input
          id="surface-min-confidence"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={filters.minConfidence}
          onChange={(event) => {
            onChange({ ...filters, minConfidence: quantiseConfidence(Number(event.target.value)) });
          }}
          className="accent-primary"
        />
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={filters.inScopeOnly}
        onClick={() => {
          onChange({ ...filters, inScopeOnly: !filters.inScopeOnly });
        }}
        className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>In scope only</span>
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex h-5 w-9 items-center rounded-full p-0.5 transition-colors motion-reduce:transition-none',
            filters.inScopeOnly ? 'bg-primary' : 'bg-muted',
          )}
        >
          <span
            className={cn(
              'h-4 w-4 rounded-full bg-background transition-transform motion-reduce:transition-none',
              filters.inScopeOnly ? 'translate-x-4' : 'translate-x-0',
            )}
          />
        </span>
      </button>
    </section>
  );
}
