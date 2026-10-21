import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  ne,
  type SQL,
  sql,
  type AnyColumn,
} from 'drizzle-orm';

import { invalidCursor } from './errors.js';
import {
  type FilterField,
  type FilterValue,
  type ListQuery,
  type ListSpec,
  type ParsedFilter,
  requestSignature,
  type SortField,
  type SortKind,
} from './spec.js';

import type { CursorCodec } from './cursor.js';
import type { ListMetrics } from './metrics.js';
import type { Page } from '@blackwing/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The expression ORDER BY and the keyset predicate share, so pages cannot drift (see API-005 notes). */
function sortExpression(column: AnyColumn, kind: SortKind): SQL {
  if (kind === 'string') return sql`${column} COLLATE "C"`;
  if (kind === 'date') return sql`date_trunc('milliseconds', ${column})`;
  return sql`${column}`;
}

function cursorParam(kind: SortKind, value: string | number): SQL {
  switch (kind) {
    case 'string':
      if (typeof value !== 'string') throw invalidCursor();
      return sql`${value}::text COLLATE "C"`;
    case 'number':
      if (typeof value !== 'number') throw invalidCursor();
      return sql`${value}`;
    case 'date': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalidCursor();
      return sql`${value}::timestamptz`;
    }
    case 'uuid':
      if (typeof value !== 'string' || !UUID.test(value)) throw invalidCursor();
      return sql`${value}::uuid`;
  }
}

function toCursorValue(kind: SortKind, value: string | number | Date): string | number {
  if (value instanceof Date) return value.toISOString();
  if (kind === 'number' && typeof value !== 'number')
    throw new TypeError('number sort value expected');
  return value;
}

function filterCondition(def: FilterField, filter: ParsedFilter): SQL {
  const [first] = filter.values;
  if (first === undefined) throw new RangeError('filter without a value');
  const column = def.column;
  switch (filter.op) {
    case 'eq':
      return eq(column, first);
    case 'ne':
      return ne(column, first);
    case 'lt':
      return lt(column, first);
    case 'lte':
      return lte(column, first);
    case 'gt':
      return gt(column, first);
    case 'gte':
      return gte(column, first);
    case 'in':
      return inArray(column, [...filter.values] as FilterValue[]);
    case 'prefix': {
      const escaped = String(first).replace(/[\\%_]/g, (ch) => `\\${ch}`);
      return sql`${column} LIKE ${`${escaped}%`} ESCAPE '\\'`;
    }
  }
}

export interface KeysetPlan {
  /** Filters AND keyset predicate; pass to `.where()`. `undefined` means no condition. */
  readonly where: SQL | undefined;
  /** Pass to `.orderBy(...orderBy)`. Always ends in the unique id. */
  readonly orderBy: readonly SQL[];
  /** Fetch this many rows (`limit + 1`) so the next page can be detected without a count. */
  readonly fetchLimit: number;
}

/**
 * Builds the WHERE and ORDER BY of a keyset page. Forward-only. The predicate is a row-value
 * comparison `(sort, id) > ($1, $2)` (`<` for desc) that matches `ORDER BY sort, id` exactly,
 * including collation, so concatenated pages equal the unpaginated query.
 *
 * Rows inserted between pages appear only if they sort after the cursor; rows deleted never cause a
 * skip or a duplicate.
 */
export function buildKeyset<R>(
  spec: ListSpec<R>,
  query: ListQuery,
  codec: CursorCodec,
): KeysetPlan {
  const sortField = spec.sorts[query.sort.field];
  if (sortField === undefined) throw new RangeError(`unknown sort field "${query.sort.field}"`);
  const direction = query.sort.direction;
  const idOnly = sortField.column === spec.id.column;
  const idExpr = sortExpression(spec.id.column, 'uuid');
  const sortExpr = sortExpression(sortField.column, sortField.kind);
  const dir = direction === 'asc' ? asc : desc;

  const conditions: SQL[] = [];
  for (const filter of query.filters) {
    const def = spec.filters[filter.field];
    if (def === undefined) throw new RangeError(`unknown filter field "${filter.field}"`);
    conditions.push(filterCondition(def, filter));
  }

  if (query.cursor !== undefined) {
    const payload = codec.decode(query.cursor, { d: direction, s: requestSignature(query) });
    const operator = direction === 'asc' ? sql.raw('>') : sql.raw('<');
    if (idOnly) {
      if (payload.k.length !== 1) throw invalidCursor();
      const [idValue] = payload.k;
      if (idValue === undefined) throw invalidCursor();
      conditions.push(sql`${idExpr} ${operator} ${cursorParam('uuid', idValue)}`);
    } else {
      if (payload.k.length !== 2) throw invalidCursor();
      const [sortValue, idValue] = payload.k;
      if (sortValue === undefined || idValue === undefined) throw invalidCursor();
      conditions.push(
        sql`(${sortExpr}, ${idExpr}) ${operator} (${cursorParam(sortField.kind, sortValue)}, ${cursorParam('uuid', idValue)})`,
      );
    }
  }

  const orderBy = idOnly ? [dir(idExpr)] : [dir(sortExpr), dir(idExpr)];
  return {
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy,
    fetchLimit: query.limit + 1,
  };
}

/** Cursor for the page that ends at `row`. */
function cursorFor<R>(
  spec: ListSpec<R>,
  sortField: SortField<R>,
  query: ListQuery,
  codec: CursorCodec,
  row: R,
): string {
  const id = spec.id.read(row);
  const key =
    sortField.column === spec.id.column
      ? [id]
      : [toCursorValue(sortField.kind, sortField.read(row)), id];
  return codec.encode({ k: key, d: query.sort.direction, s: requestSignature(query) });
}

export interface ListPageOptions<R> {
  readonly spec: ListSpec<R>;
  readonly query: ListQuery;
  readonly codec: CursorCodec;
  /** Route template for the `list_requests_total{route}` label. */
  readonly route: string;
  readonly metrics?: ListMetrics;
  /**
   * Runs the repository query inside the caller's tenant context (RLS, `withTenant`) with
   * `.where(plan.where).orderBy(...plan.orderBy).limit(plan.fetchLimit)`.
   */
  readonly fetch: (plan: KeysetPlan) => Promise<readonly R[]>;
}

/** Fetches one page and wraps it in the `Page<T>` envelope. */
export async function listPage<R>(options: ListPageOptions<R>): Promise<Page<R>> {
  const { spec, query, codec, fetch, metrics, route } = options;
  const sortField = spec.sorts[query.sort.field];
  if (sortField === undefined) throw new RangeError(`unknown sort field "${query.sort.field}"`);
  const plan = buildKeyset(spec, query, codec);
  const rows = await fetch(plan);
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);
  const nextCursor =
    hasMore && last !== undefined ? cursorFor(spec, sortField, query, codec, last) : null;
  metrics?.record(route, items.length);
  return { items, nextCursor, hasMore };
}
