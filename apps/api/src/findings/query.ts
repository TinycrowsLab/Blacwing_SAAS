import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  MAX_CURSOR_LENGTH,
  FINDING_LIST_LIMIT_DEFAULT,
  FINDING_LIST_LIMIT_MAX,
  type FindingListFilters,
  findingListFiltersSchema,
} from '@blackwing/contracts';
import { cweRefSchema, owaspTop10RefSchema } from '@blackwing/domain';

import { badPageQuery, invalidFilter } from '../pagination/index.js';

/** Digest length of a request signature in characters (128 bits, base64url). */
const SIGNATURE_LENGTH = 22;

/** The query keys that are not filters. Every other key is one, and an unknown one is refused. */
const PAGE_KEYS: ReadonlySet<string> = new Set(['cursor', 'limit']);

/** A validated `GET /v1/findings` query: the filters, the raw cursor and the page size. */
export interface ParsedFindingListQuery {
  readonly filters: FindingListFilters;
  readonly cursor: string | undefined;
  readonly limit: number;
}

/** Cursor: a non-empty string of at most 2048 characters (the signature is checked later, `invalid_cursor`). */
const cursorParam = z.string().min(1).max(MAX_CURSOR_LENGTH).optional();

/** A whole number from 1 up; above the maximum it is clamped (§9). Zero, negatives and non-integers are refused. */
const limitParam = z
  .union([z.number(), z.string().regex(/^[+-]?\d+$/, 'must be an integer')])
  .transform(Number)
  .pipe(z.number().int().min(1))
  .transform((value) => Math.min(value, FINDING_LIST_LIMIT_MAX))
  .optional();

/**
 * Parses the query string of `GET /v1/findings`. A bad `cursor` or `limit` answers `400 bad_request`. An unknown
 * filter, an unusable value, or a CWE or OWASP id that is not in the pinned lists answers `400 invalid_filter`.
 * Nothing is silently dropped: a misspelt filter fails instead of returning every finding.
 */
export function parseFindingListQuery(
  raw: Readonly<Record<string, unknown>>,
): ParsedFindingListQuery {
  const cursor = cursorParam.safeParse(raw.cursor);
  if (!cursor.success)
    throw badPageQuery('cursor: must be a non-empty string of at most 2048 characters');
  const limit = limitParam.safeParse(raw.limit);
  if (!limit.success) throw badPageQuery('limit: must be a whole number of at least 1');

  const filterInput: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PAGE_KEYS.has(key) && value !== undefined) filterInput[key] = value;
  }
  const filters = findingListFiltersSchema.safeParse(filterInput);
  if (!filters.success) {
    const fields = filters.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw invalidFilter(`Invalid filter: ${[...new Set(fields)].join(', ')}.`);
  }
  const { cwe, owasp } = filters.data;
  if (cwe !== undefined && !cweRefSchema.safeParse(cwe).success) {
    throw invalidFilter('Invalid filter: cwe is not a known CWE id.');
  }
  if (owasp !== undefined && !owaspTop10RefSchema.safeParse(owasp).success) {
    throw invalidFilter('Invalid filter: owasp is not a known OWASP Top 10 category.');
  }
  return {
    filters: filters.data,
    cursor: cursor.data,
    limit: limit.data ?? FINDING_LIST_LIMIT_DEFAULT,
  };
}

/**
 * Digest of the filters a cursor was issued for, and of whether the viewer may see suspected findings. A cursor
 * replayed with other filters, or by a viewer with other visibility, is `invalid_cursor`. The page size may change.
 */
export function findingQuerySignature(
  filters: FindingListFilters,
  suspectedVisible: boolean,
): string {
  const entries = Object.entries(filters).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256')
    .update(JSON.stringify([entries, suspectedVisible]))
    .digest('base64url')
    .slice(0, SIGNATURE_LENGTH);
}
