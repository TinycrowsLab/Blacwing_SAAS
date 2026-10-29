import type { QueryKey } from '@tanstack/react-query';

/** A JSON-serialisable filter value. */
type FilterValue = string | number | boolean | null | undefined | readonly (string | number)[];
/** Filters of a list query, e.g. `{ status: 'running', limit: 50 }`. */
type ListFilters = Readonly<Record<string, FilterValue>>;

/**
 * Canonical filters: keys sorted, `undefined` dropped, so two filter objects that mean the same thing
 * always produce the same (serialisable, hashable) key regardless of property order.
 */
function normalise(filters: ListFilters): Record<string, Exclude<FilterValue, undefined>> {
  const out: Record<string, Exclude<FilterValue, undefined>> = {};
  for (const key of Object.keys(filters).sort()) {
    const value = filters[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Key set of one REST resource: `all` prefixes every key so one call invalidates the whole resource. */
export interface ResourceKeys<Id extends string> {
  readonly all: readonly [string];
  readonly lists: () => readonly [string, 'list'];
  readonly list: (filters?: ListFilters) => readonly [string, 'list', Record<string, unknown>];
  readonly detail: (id: Id) => readonly [string, 'detail', Id];
}

/** Builds the `all` / `list(filters)` / `detail(id)` keys of a resource (`qk.runs.list(...)`). */
export function createResourceKeys<Id extends string = string>(resource: string): ResourceKeys<Id> {
  return {
    all: [resource] as const,
    lists: () => [resource, 'list'] as const,
    list: (filters = {}) => [resource, 'list', normalise(filters)] as const,
    detail: (id) => [resource, 'detail', id] as const,
  };
}

/** Query-key factory used by every console query (CONSOLE-005). Feature epics add their resources here. */
export const qk = {
  runs: createResourceKeys('runs'),
  /** The surface view of one run for one filter state (`runs/:id/surface`, GRAPH-006); pages are infinite. */
  surface: (runId: string, filters: ListFilters): readonly [string, string, string, object] =>
    ['runs', runId, 'surface', normalise(filters)] as const,
  /** Read-only GraphQL operations, keyed by operation name and variables (CONSOLE-005 / GRAPHQL client). */
  graphql: (operationName: string, variables: object): readonly [string, string, object] =>
    ['graphql', operationName, variables] as const,
} as const;

/** Keys a mutation invalidates on success, via `meta: { invalidates: [...] }` (see `makeQueryClient`). */
export interface InvalidatesMeta {
  readonly invalidates?: readonly QueryKey[];
}
