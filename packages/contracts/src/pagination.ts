import { z } from 'zod';

/** Default page size (CONTEXT_PACK §9, API-005). */
export const DEFAULT_PAGE_LIMIT = 50;
/** Largest page a client may ask for; larger values are clamped, not rejected. */
export const MAX_PAGE_LIMIT = 200;
/** Longest cursor accepted on the wire. Real cursors are far shorter; this bounds hostile input. */
export const MAX_CURSOR_LENGTH = 2048;

/**
 * `?cursor=&limit=` of every list endpoint. `limit` is coerced from a query string, defaults to 50 and
 * is clamped to 200. Zero, negatives and non-integers are rejected. The cursor stays opaque here: the
 * API verifies its signature (`invalid_cursor`).
 */
export const PageQuerySchema = z.object({
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  limit: z
    .union([z.number(), z.string().regex(/^[+-]?\d+$/, 'must be an integer')])
    .transform(Number)
    .pipe(z.number().int().min(1))
    .transform((value) => Math.min(value, MAX_PAGE_LIMIT))
    .default(DEFAULT_PAGE_LIMIT),
});
export type PageQuery = z.output<typeof PageQuerySchema>;

/** The `Page<T>` envelope returned by every list endpoint. */
export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor of the next page, or `null` on the last page. */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Zod schema of `Page<T>` for an item schema (OpenAPI response bodies and client parsing). */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });
}
