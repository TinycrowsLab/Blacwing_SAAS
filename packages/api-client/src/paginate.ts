import type { Page } from '@blackwing/contracts';

export interface PaginateOptions {
  /** Most pages fetched, 1 or more (default 50). The walk stops quietly at this bound. */
  readonly maxPages?: number;
  /** Wall-clock bound for the whole walk in ms (default 60000). No page starts after it. */
  readonly maxDurationMs?: number;
}

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_DURATION_MS = 60_000;

/**
 * Yields every item of a cursor-paginated list, following `nextCursor` until it is null. `fetchPage`
 * receives `query` with the cursor set, so pass a client method: `paginate((query) => client.listX({ query }), {}, { maxPages: 5 })`.
 * The walk stops quietly at `maxPages` or `maxDurationMs`. A cursor that repeats throws, because it would loop.
 */
export async function* paginate<Query extends { cursor?: string }, Item>(
  fetchPage: (query: Query) => Promise<{ readonly data: Page<Item> }>,
  query: Query,
  options: PaginateOptions = {},
): AsyncGenerator<Item, void, undefined> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  if (!Number.isInteger(maxPages) || maxPages < 1)
    throw new RangeError('maxPages must be a positive integer');
  if (!(maxDurationMs > 0)) throw new RangeError('maxDurationMs must be positive');

  const deadline = performance.now() + maxDurationMs;
  const seen = new Set<string>();
  if (query.cursor !== undefined) seen.add(query.cursor);
  let current = query;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && performance.now() > deadline) return;
    const { data } = await fetchPage(current);
    for (const item of data.items) yield item;
    if (data.nextCursor === null) return;
    if (seen.has(data.nextCursor))
      throw new Error('pagination cursor repeated; stopping to avoid a loop');
    seen.add(data.nextCursor);
    current = { ...query, cursor: data.nextCursor };
  }
}
