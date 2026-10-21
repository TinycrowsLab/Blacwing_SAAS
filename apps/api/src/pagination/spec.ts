import { createHash } from 'node:crypto';

import { z } from 'zod';

import { PageQuerySchema } from '@blackwing/contracts';

import { badPageQuery, invalidFilter } from './errors.js';

import type { Direction } from './cursor.js';
import type { AnyColumn } from 'drizzle-orm';

/**
 * How a sort column is compared. `string` uses `COLLATE "C"` (byte order) and `date` truncates to
 * milliseconds, in both ORDER BY and the keyset predicate, so the cursor and the query agree exactly.
 */
export type SortKind = 'string' | 'number' | 'date' | 'uuid';
export type SortValue = string | number | Date;

export interface SortField<R> {
  readonly column: AnyColumn;
  readonly kind: SortKind;
  /** The sort value of a fetched row (what the cursor records). */
  readonly read: (row: R) => SortValue;
}

export const FILTER_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'prefix'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export type FilterValue = string | number | boolean | Date;

export interface FilterField {
  readonly column: AnyColumn;
  readonly ops: readonly FilterOp[];
  /** Parses one raw query-string value (a string); a failure is `invalid_filter`. */
  readonly value: z.ZodType<FilterValue, string>;
}

/** Per-endpoint allowlists. Feature epics supply these; nothing outside them reaches SQL. */
export interface ListSpec<R> {
  readonly sorts: Readonly<Record<string, SortField<R>>>;
  readonly defaultSort: { readonly field: string; readonly direction: Direction };
  /** The unique tiebreaker appended to every ORDER BY (a uuid primary key). */
  readonly id: { readonly column: AnyColumn; readonly read: (row: R) => string };
  readonly filters: Readonly<Record<string, FilterField>>;
}

export interface ParsedFilter {
  readonly field: string;
  readonly op: FilterOp;
  readonly values: readonly FilterValue[];
}

export interface ListQuery {
  readonly cursor: string | undefined;
  readonly limit: number;
  readonly sort: { readonly field: string; readonly direction: Direction };
  readonly filters: readonly ParsedFilter[];
}

/** Ready-made value parsers for {@link FilterField.value}. */
export const filterValue = {
  string: (max = 200) => z.string().min(1).max(max),
  uuid: () => z.uuid(),
  number: () =>
    z
      .string()
      .regex(/^-?\d+(?:\.\d+)?$/)
      .transform(Number),
  boolean: () => z.enum(['true', 'false']).transform((value) => value === 'true'),
  date: () => z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  enum: <const T extends readonly [string, ...string[]]>(values: T) => z.enum(values),
} as const;

const SIGNATURE_LENGTH = 22;
export const MAX_FILTERS = 20;
export const MAX_IN_VALUES = 100;

const BRACKET_KEY = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/;
const FILTER_OP_SET: ReadonlySet<string> = new Set(FILTER_OPS);

interface RawFilter {
  readonly field: string;
  readonly op: string;
  readonly raw: unknown;
}

/** Collects `filter[f]=v`, `filter[f][op]=v` (flat keys) and a nested `filter` object. */
function rawFilters(query: Readonly<Record<string, unknown>>): RawFilter[] {
  const found: RawFilter[] = [];
  for (const [key, raw] of Object.entries(query)) {
    const match = BRACKET_KEY.exec(key);
    if (match?.[1] !== undefined) found.push({ field: match[1], op: match[2] ?? 'eq', raw });
  }
  const nested = query.filter;
  if (nested !== undefined) {
    if (typeof nested !== 'object' || nested === null || Array.isArray(nested))
      throw invalidFilter('filter must be of the form filter[field]=value');
    for (const [field, entry] of Object.entries(nested as Record<string, unknown>)) {
      if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
        for (const [op, raw] of Object.entries(entry as Record<string, unknown>))
          found.push({ field, op, raw });
      } else found.push({ field, op: 'eq', raw: entry });
    }
  }
  return found;
}

function asStrings(raw: unknown, op: string): string[] {
  if (op === 'in') {
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [raw];
    return list.map((item) => (typeof item === 'string' ? item : ''));
  }
  return [typeof raw === 'string' ? raw : ''];
}

function parseSort<R>(spec: ListSpec<R>, raw: unknown): ListQuery['sort'] {
  if (raw === undefined) return spec.defaultSort;
  if (typeof raw !== 'string' || raw === '')
    throw invalidFilter('sort must be "field" or "field:asc|desc"');
  const [field = '', direction = 'asc', ...rest] = raw.split(':');
  if (rest.length > 0 || (direction !== 'asc' && direction !== 'desc'))
    throw invalidFilter('sort direction must be asc or desc');
  if (!Object.hasOwn(spec.sorts, field)) throw invalidFilter(`cannot sort by "${field}"`);
  return { field, direction };
}

/**
 * Parses `cursor`, `limit`, `sort` and `filter[...]` of a request against the endpoint's allowlists.
 * Limit problems answer `400 bad_request`; any field, operator or sort outside the allowlist, or an
 * unusable value, answers `400 invalid_filter`. Values are parsed to typed values and only ever reach
 * SQL as bound parameters; column references come solely from the allowlist.
 */
export function parseListQuery<R>(
  spec: ListSpec<R>,
  query: Readonly<Record<string, unknown>>,
): ListQuery {
  const page = PageQuerySchema.safeParse({ cursor: query.cursor, limit: query.limit });
  if (!page.success)
    throw badPageQuery(
      page.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  const sort = parseSort(spec, query.sort);
  const raws = rawFilters(query);
  if (raws.length > MAX_FILTERS) throw invalidFilter('too many filters');
  const filters: ParsedFilter[] = [];
  for (const { field, op, raw } of raws) {
    if (!Object.hasOwn(spec.filters, field)) throw invalidFilter(`cannot filter by "${field}"`);
    const def = spec.filters[field];
    if (def === undefined || !FILTER_OP_SET.has(op) || !def.ops.includes(op as FilterOp))
      throw invalidFilter(`operator "${op}" is not allowed on "${field}"`);
    const strings = asStrings(raw, op);
    if (strings.length === 0 || strings.length > MAX_IN_VALUES)
      throw invalidFilter(`"${field}" needs between 1 and ${String(MAX_IN_VALUES)} values`);
    const values = strings.map((text) => {
      const parsed = def.value.safeParse(text);
      if (!parsed.success) throw invalidFilter(`invalid value for "${field}"`);
      return parsed.data;
    });
    filters.push({ field, op: op as FilterOp, values });
  }
  filters.sort((a, b) => `${a.field}.${a.op}`.localeCompare(`${b.field}.${b.op}`));
  return { cursor: page.data.cursor, limit: page.data.limit, sort, filters };
}

const canonical = (value: FilterValue): string | number | boolean =>
  value instanceof Date ? value.toISOString() : value;

/** Digest binding a cursor to the sort and filters it was issued for (limit may differ per page). */
export function requestSignature(query: Pick<ListQuery, 'sort' | 'filters'>): string {
  const material = JSON.stringify([
    query.sort.field,
    query.sort.direction,
    query.filters.map((f) => [f.field, f.op, f.values.map((value) => canonical(value))]),
  ]);
  return createHash('sha256').update(material).digest('base64url').slice(0, SIGNATURE_LENGTH);
}
