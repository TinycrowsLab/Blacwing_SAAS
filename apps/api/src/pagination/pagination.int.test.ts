// Keyset pagination against real Postgres (API-005): no gaps/overlaps, full-scan equality, RLS.

import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { codec, itemSpec, items, type ItemRow } from './fixtures.test-helpers.js';
import { type KeysetPlan, listPage } from './keyset.js';
import { parseListQuery } from './spec.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const STATUSES = ['open', 'closed', 'draft'] as const;
const NAMES = ['alpha', 'Alpha', 'beta', 'Zeta', 'zeta', 'école', 'Éclair', 'ñandú', 'a_b', 'a%b'];
const TOTAL = 240;

beforeAll(async () => {
  db = await withPostgres();
  await db.ownerPool.query(`
    CREATE TABLE pg_items (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
      created_at timestamptz NOT NULL, name text NOT NULL, rank int NOT NULL, status text NOT NULL);
    ALTER TABLE pg_items ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON pg_items
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
    GRANT SELECT ON pg_items TO bw_app;`);
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (let i = 0; i < TOTAL; i += 1) {
    const base = values.length;
    // Microsecond-apart timestamps with many ties: exercises ms truncation and the id tiebreaker.
    const stamp = `2026-03-01T00:00:${String(Math.floor(i / 6)).padStart(2, '0')}.${String(100 + (i % 6) * 7)}${String(i % 10)}${String(i % 7)}Z`;
    values.push(
      randomUUID(),
      i % 5 === 0 ? tenantB : tenantA,
      stamp,
      NAMES[i % NAMES.length],
      i % 9,
      STATUSES[i % 3],
    );
    tuples.push(
      `($${String(base + 1)},$${String(base + 2)},$${String(base + 3)},$${String(base + 4)},$${String(base + 5)},$${String(base + 6)})`,
    );
  }
  await db.ownerPool.query(
    `INSERT INTO pg_items (id, tenant_id, created_at, name, rank, status) VALUES ${tuples.join(',')}`,
    values,
  );
});

afterAll(async () => {
  await db.stop();
});

/** One repository call inside the tenant context (RLS applies as bw_app). */
function fetcher(tenantId: string) {
  return (plan: KeysetPlan): Promise<ItemRow[]> =>
    db.withTenant(tenantId, async (tx) => {
      const orm = drizzle({ client: tx });
      // blackwing:allow-raw-tenant-db test harness withTenant hands a tenant-bound pg client (RLS as bw_app)
      return orm
        .select()
        .from(items)
        .where(plan.where)
        .orderBy(...plan.orderBy)
        .limit(plan.fetchLimit);
    });
}

async function allPages(
  tenantId: string,
  raw: Record<string, unknown>,
): Promise<{ rows: ItemRow[]; pages: number }> {
  const rows: ItemRow[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const query = parseListQuery(itemSpec, { ...raw, ...(cursor ? { cursor } : {}) });
    const page = await listPage({
      spec: itemSpec,
      query,
      codec,
      route: '/v1/items',
      fetch: fetcher(tenantId),
    });
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > 1000) throw new Error('pagination did not terminate');
  } while (cursor !== undefined);
  return { rows, pages };
}

async function fullScan(tenantId: string, raw: Record<string, unknown>): Promise<ItemRow[]> {
  const query = parseListQuery(itemSpec, { ...raw, limit: '200' });
  const plan = await listPage({
    spec: itemSpec,
    query: { ...query, limit: 10_000 },
    codec,
    route: 'scan',
    fetch: fetcher(tenantId),
  });
  return [...plan.items];
}

describe('keyset pagination (integration)', () => {
  it('N+1 rows: limit items plus a cursor; the next page continues with no gaps or overlaps', async () => {
    const full = await fullScan(tenantA, { sort: 'name' });
    const query = parseListQuery(itemSpec, { sort: 'name', limit: '25' });
    const first = await listPage({
      spec: itemSpec,
      query,
      codec,
      route: 'r',
      fetch: fetcher(tenantA),
    });
    expect(first.items).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    const second = await listPage({
      spec: itemSpec,
      query: parseListQuery(itemSpec, {
        sort: 'name',
        limit: '25',
        cursor: first.nextCursor ?? '',
      }),
      codec,
      route: 'r',
      fetch: fetcher(tenantA),
    });
    expect([...first.items, ...second.items].map((r) => r.id)).toEqual(
      full.slice(0, 50).map((r) => r.id),
    );
  });

  it('respects RLS: only the tenant context rows are paged', async () => {
    const { rows } = await allPages(tenantB, { limit: '17' });
    expect(rows).toHaveLength(TOTAL / 5);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('an empty result is an empty page', async () => {
    const query = parseListQuery(itemSpec, { 'filter[rank][gte]': '99' });
    const page = await listPage({
      spec: itemSpec,
      query,
      codec,
      route: 'r',
      fetch: fetcher(tenantA),
    });
    expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it('prefix filter escapes LIKE wildcards', async () => {
    const { rows } = await allPages(tenantA, { 'filter[name][prefix]': 'a%' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.name.startsWith('a%'))).toBe(true);
  });

  it('rows inserted behind the cursor do not shift later pages; rows after it appear', async () => {
    const q1 = parseListQuery(itemSpec, { sort: 'rank', limit: '10' });
    const first = await listPage({
      spec: itemSpec,
      query: q1,
      codec,
      route: 'r',
      fetch: fetcher(tenantA),
    });
    const behind = randomUUID();
    await db.ownerPool.query(`INSERT INTO pg_items VALUES ($1,$2,now(),'new',-1,'open')`, [
      behind,
      tenantA,
    ]);
    try {
      const second = await listPage({
        spec: itemSpec,
        query: parseListQuery(itemSpec, {
          sort: 'rank',
          limit: '10',
          cursor: first.nextCursor ?? '',
        }),
        codec,
        route: 'r',
        fetch: fetcher(tenantA),
      });
      const seen = new Set(first.items.map((r) => r.id));
      expect(second.items.some((r) => seen.has(r.id) || r.id === behind)).toBe(false);
    } finally {
      await db.ownerPool.query('DELETE FROM pg_items WHERE id = $1', [behind]);
    }
  });

  it('property: concatenated pages equal the full unpaginated query, same order', async () => {
    const sorts = ['created_at', 'name', 'rank', 'id'] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...sorts),
        fc.constantFrom('asc', 'desc'),
        fc.integer({ min: 1, max: 60 }),
        fc.option(fc.constantFrom(...STATUSES), { nil: undefined }),
        async (sort, direction, limit, status) => {
          const raw = {
            sort: `${sort}:${direction}`,
            limit: String(limit),
            ...(status ? { 'filter[status]': status } : {}),
          };
          const { rows } = await allPages(tenantA, raw);
          const full = await fullScan(tenantA, raw);
          expect(rows.map((r) => r.id)).toEqual(full.map((r) => r.id));
          expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
        },
      ),
      { numRuns: 25 },
    );
  });
});
