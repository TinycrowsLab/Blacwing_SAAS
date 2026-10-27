import { describe, expect, it, vi } from 'vitest';

import { paginate } from './index.js';

interface Page {
  readonly data: { items: readonly string[]; nextCursor: string | null; hasMore: boolean };
}

/** A list of pages keyed by the cursor that requests them; `null` starts the walk. */
function pagesFrom(pages: Record<string, { items: string[]; next: string | null }>) {
  return vi.fn((query: { cursor?: string; limit?: number }): Promise<Page> => {
    const page = pages[query.cursor ?? 'start'];
    if (page === undefined) return Promise.reject(new Error(`no page for ${String(query.cursor)}`));
    return Promise.resolve({
      data: { items: page.items, nextCursor: page.next, hasMore: page.next !== null },
    });
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('paginate', () => {
  it('walks every page and yields items in order', async () => {
    const fetchPage = pagesFrom({
      start: { items: ['a', 'b'], next: 'c1' },
      c1: { items: ['c'], next: 'c2' },
      c2: { items: ['d', 'e'], next: null },
    });
    const items = await collect(paginate(fetchPage, { limit: 2 }));
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[1]?.[0]).toEqual({ limit: 2, cursor: 'c1' });
  });

  it('stops after one empty last page and does not request past nextCursor null', async () => {
    const fetchPage = pagesFrom({ start: { items: [], next: null } });
    expect(await collect(paginate(fetchPage, {}))).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('starts from a caller-supplied cursor', async () => {
    const fetchPage = pagesFrom({ resume: { items: ['z'], next: null } });
    expect(await collect(paginate(fetchPage, { cursor: 'resume' }))).toEqual(['z']);
  });

  it('stops quietly at maxPages even when more pages exist', async () => {
    const fetchPage = pagesFrom({
      start: { items: ['a'], next: 'c1' },
      c1: { items: ['b'], next: 'c2' },
      c2: { items: ['c'], next: null },
    });
    expect(await collect(paginate(fetchPage, {}, { maxPages: 2 }))).toEqual(['a', 'b']);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('stops quietly when maxDurationMs has passed before the next page', async () => {
    const fetchPage = vi.fn(
      (query: { cursor?: string }): Promise<Page> =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              data: {
                items: [query.cursor ?? 'start'],
                nextCursor: query.cursor === undefined ? 'next' : 'after',
                hasMore: true,
              },
            });
          }, 20);
        }),
    );
    const items = await collect(paginate(fetchPage, {}, { maxDurationMs: 5 }));
    expect(items).toEqual(['start']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws when a cursor repeats, instead of looping forever', async () => {
    const fetchPage = pagesFrom({
      start: { items: ['a'], next: 'loop' },
      loop: { items: ['b'], next: 'loop' },
    });
    await expect(collect(paginate(fetchPage, {}))).rejects.toThrow(/cursor repeated/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('throws when the walk returns to the starting cursor', async () => {
    const fetchPage = pagesFrom({ resume: { items: ['a'], next: 'resume' } });
    await expect(collect(paginate(fetchPage, { cursor: 'resume' }))).rejects.toThrow(
      /cursor repeated/,
    );
  });

  it('propagates a page failure without yielding further items', async () => {
    const fetchPage = vi.fn((query: { cursor?: string }): Promise<Page> => {
      if (query.cursor === undefined) {
        return Promise.resolve({ data: { items: ['a'], nextCursor: 'c1', hasMore: true } });
      }
      return Promise.reject(new Error('upstream 503'));
    });
    await expect(collect(paginate(fetchPage, {}))).rejects.toThrow('upstream 503');
  });

  it('rejects invalid bounds before fetching anything', async () => {
    const fetchPage = pagesFrom({ start: { items: [], next: null } });
    await expect(collect(paginate(fetchPage, {}, { maxPages: 0 }))).rejects.toThrow(RangeError);
    await expect(collect(paginate(fetchPage, {}, { maxPages: 1.5 }))).rejects.toThrow(RangeError);
    await expect(collect(paginate(fetchPage, {}, { maxDurationMs: 0 }))).rejects.toThrow(
      RangeError,
    );
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
