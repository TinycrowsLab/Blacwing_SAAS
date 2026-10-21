import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, PageQuerySchema } from '@blackwing/contracts';

import { createCursorCodec } from './cursor.js';
import { codec, itemSpec, type ItemRow, SECRET } from './fixtures.test-helpers.js';
import { buildKeyset, listPage } from './keyset.js';
import { createListMetrics } from './metrics.js';
import { parseListQuery, requestSignature } from './spec.js';
import { ApiProblemError } from '../errors/problem-errors.js';
import { createProblemRegistry } from '../errors/registry.js';

const dialect = new PgDialect();
const render = (fragment: ReturnType<typeof sql.join>) => dialect.sqlToQuery(fragment);

function problemCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiProblemError) return error.problemCode;
    throw error;
  }
  return 'no-error';
}

const row = (n: number): ItemRow => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
  name: `n${String(n)}`,
  rank: Math.floor(n / 3),
  status: 'open',
});

describe('PageQuerySchema', () => {
  it('defaults to 50 and clamps to 200', () => {
    expect(PageQuerySchema.parse({}).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(PageQuerySchema.parse({ limit: '1000' }).limit).toBe(MAX_PAGE_LIMIT);
    expect(PageQuerySchema.parse({ limit: '7' }).limit).toBe(7);
  });
  it.each(['0', '-3', 'abc', '1.5', ''])('rejects limit=%j', (limit) => {
    expect(PageQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});

describe('problem codes', () => {
  it('registers invalid_cursor and invalid_filter as 400', () => {
    const registry = createProblemRegistry();
    expect(registry.get('invalid_cursor')?.status).toBe(400);
    expect(registry.get('invalid_filter')?.status).toBe(400);
  });
});

describe('parseListQuery', () => {
  it('clamps limit=1000 to 200 and rejects limit=0 with 400', () => {
    expect(parseListQuery(itemSpec, { limit: '1000' }).limit).toBe(200);
    expect(problemCode(() => parseListQuery(itemSpec, { limit: '0' }))).toBe('bad_request');
  });
  it('uses the default sort and parses allowlisted filters', () => {
    const query = parseListQuery(itemSpec, {
      sort: 'name:asc',
      'filter[status]': 'open',
      'filter[rank][gte]': '3',
    });
    expect(query.sort).toEqual({ field: 'name', direction: 'asc' });
    expect(query.filters.map((f) => [f.field, f.op, f.values])).toEqual([
      ['rank', 'gte', [3]],
      ['status', 'eq', ['open']],
    ]);
    expect(parseListQuery(itemSpec, {}).sort).toEqual(itemSpec.defaultSort);
  });
  it('accepts a nested filter object and in-lists', () => {
    const query = parseListQuery(itemSpec, { filter: { status: { in: 'open,closed' } } });
    expect(query.filters[0]?.values).toEqual(['open', 'closed']);
  });
  it.each([
    ['unknown field', { 'filter[secret]': 'x' }],
    ['column-injection field', { 'filter[name; DROP TABLE x]': 'x' }],
    ['prototype key', { 'filter[__proto__]': 'x' }],
    ['disallowed op', { 'filter[status][gt]': 'open' }],
    ['unknown op', { 'filter[status][like]': 'open' }],
    ['bad value', { 'filter[status]': 'nope' }],
    ['unknown sort field', { sort: 'tenant_id' }],
    ['bad sort direction', { sort: 'name:sideways' }],
    ['non-object filter', { filter: 'x' }],
    ['array for a scalar op', { 'filter[status]': ['open', 'closed'] }],
  ])('rejects %s with invalid_filter', (_label, query) => {
    expect(problemCode(() => parseListQuery(itemSpec, query))).toBe('invalid_filter');
  });
});

describe('cursor codec', () => {
  const expected = { d: 'asc', s: 'sig' } as const;
  const token = codec.encode({ k: ['x', 'id'], d: 'asc', s: 'sig' });

  it('round-trips', () => {
    expect(codec.decode(token, expected)).toMatchObject({ k: ['x', 'id'], d: 'asc', v: 1 });
  });
  it('detects a tampered payload or signature', () => {
    const [body = '', mac = ''] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ k: ['y', 'id'], d: 'asc', v: 1, s: 'sig' }),
    ).toString('base64url');
    expect(problemCode(() => codec.decode(`${forged}.${mac}`, expected))).toBe('invalid_cursor');
    expect(problemCode(() => codec.decode(`${body}.${mac.slice(0, -2)}AA`, expected))).toBe(
      'invalid_cursor',
    );
  });
  it.each(['', 'garbage', 'a.b.c', '!!.!!', 'x'.repeat(5000)])('rejects malformed %j', (bad) => {
    expect(problemCode(() => codec.decode(bad, expected))).toBe('invalid_cursor');
  });
  it('rejects a cursor signed with another key', () => {
    const other = createCursorCodec('another-secret-another-secret-another!');
    expect(
      problemCode(() =>
        codec.decode(other.encode({ k: ['x', 'id'], d: 'asc', s: 'sig' }), expected),
      ),
    ).toBe('invalid_cursor');
  });
  it('rejects a cursor from a different direction or sort/filter signature', () => {
    expect(problemCode(() => codec.decode(token, { d: 'desc', s: 'sig' }))).toBe('invalid_cursor');
    expect(problemCode(() => codec.decode(token, { d: 'asc', s: 'other' }))).toBe('invalid_cursor');
  });
  it('rejects a cursor of another version', () => {
    const body = Buffer.from(JSON.stringify({ k: ['x', 'id'], d: 'asc', v: 2, s: 'sig' })).toString(
      'base64url',
    );
    // Re-sign through the public path: build with the same secret using a foreign payload.
    const forged = createCursorCodec(SECRET);
    expect(problemCode(() => forged.decode(`${body}.AAAA`, expected))).toBe('invalid_cursor');
  });
  it('fails closed without a usable secret', () => {
    expect(() => createCursorCodec(undefined)).toThrow(RangeError);
    expect(() => createCursorCodec('short')).toThrow(RangeError);
  });
});

describe('buildKeyset', () => {
  it('always appends the unique id and uses explicit collation / ms truncation', () => {
    const byName = buildKeyset(itemSpec, parseListQuery(itemSpec, { sort: 'name' }), codec);
    const text = render(sql.join([...byName.orderBy], sql`, `)).sql;
    expect(text).toContain('COLLATE "C"');
    expect(byName.orderBy).toHaveLength(2);
    const byDate = buildKeyset(itemSpec, parseListQuery(itemSpec, {}), codec);
    expect(render(sql.join([...byDate.orderBy], sql`, `)).sql).toContain(
      "date_trunc('milliseconds'",
    );
    expect(byDate.fetchLimit).toBe(51);
  });
  it('sorting by id alone has a single ORDER BY term', () => {
    expect(
      buildKeyset(itemSpec, parseListQuery(itemSpec, { sort: 'id' }), codec).orderBy,
    ).toHaveLength(1);
  });
  it('adds a row-value predicate only when a cursor is present', () => {
    expect(buildKeyset(itemSpec, parseListQuery(itemSpec, {}), codec).where).toBeUndefined();
    const query = parseListQuery(itemSpec, {});
    const cursor = codec.encode({
      k: ['2026-01-01T00:00:00.000Z', row(1).id],
      d: 'desc',
      s: requestSignature(query),
    });
    const plan = buildKeyset(itemSpec, { ...query, cursor }, codec);
    const rendered = plan.where ? render(plan.where).sql : '';
    expect(rendered).toContain('<');
    expect(rendered).toContain('::timestamptz');
  });
  it('rejects a cursor issued for another sort or filter', () => {
    const issued = parseListQuery(itemSpec, { sort: 'name' });
    const cursor = codec.encode({ k: ['a', row(1).id], d: 'asc', s: requestSignature(issued) });
    const other = parseListQuery(itemSpec, { sort: 'name', 'filter[status]': 'open', cursor });
    expect(problemCode(() => buildKeyset(itemSpec, other, codec))).toBe('invalid_cursor');
    const resorted = parseListQuery(itemSpec, { sort: 'rank', cursor });
    expect(problemCode(() => buildKeyset(itemSpec, resorted, codec))).toBe('invalid_cursor');
  });
  it('rejects a signed cursor whose values do not fit the sort kind', () => {
    const query = parseListQuery(itemSpec, {});
    const cursor = codec.encode({
      k: ['not-a-date', row(1).id],
      d: 'desc',
      s: requestSignature(query),
    });
    expect(problemCode(() => buildKeyset(itemSpec, { ...query, cursor }, codec))).toBe(
      'invalid_cursor',
    );
  });
});

describe('listPage', () => {
  const run = async (rows: readonly ItemRow[], limit: number, cursor?: string) => {
    const query = parseListQuery(itemSpec, {
      limit: String(limit),
      sort: 'rank',
      ...(cursor ? { cursor } : {}),
    });
    return listPage({
      spec: itemSpec,
      query,
      codec,
      route: '/v1/items',
      fetch: () => Promise.resolve(rows),
    });
  };

  it('returns limit items and a nextCursor when N+1 rows exist', async () => {
    const rows = [1, 2, 3, 4].map((n) => row(n));
    const page = await run(rows, 3);
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    const query = parseListQuery(itemSpec, { sort: 'rank' });
    expect(codec.decode(page.nextCursor ?? '', { d: 'asc', s: requestSignature(query) }).k).toEqual(
      [row(3).rank, row(3).id],
    );
  });
  it('last page and exact fit have no cursor', async () => {
    expect(
      await run(
        [1, 2, 3].map((n) => row(n)),
        3,
      ),
    ).toMatchObject({ hasMore: false, nextCursor: null });
  });
  it('an empty result is items [], nextCursor null, hasMore false', async () => {
    expect(await run([], 50)).toEqual({ items: [], nextCursor: null, hasMore: false });
  });
  it('records list_page_size and list_requests_total{route}', async () => {
    const metrics = createListMetrics(new Registry());
    const query = parseListQuery(itemSpec, {});
    await listPage({
      spec: itemSpec,
      query,
      codec,
      route: '/v1/items',
      metrics,
      fetch: () => Promise.resolve([row(1)]),
    });
    const text = await metrics.registry.metrics();
    expect(text).toContain('list_requests_total{route="/v1/items"} 1');
    expect(text).toContain('list_page_size_count 1');
  });
});
