import { z } from 'zod';

import { LIMITS } from './limits.js';

/**
 * Shared primitive schemas for the entity contracts (CONTEXT_PACK §5 TypeScript conventions).
 *
 * `@blackwing/contracts` depends on nothing internal (docs/architecture/typescript.md), so the UUIDv7
 * rule is restated here instead of importing `@blackwing/ids`. Both accept exactly the canonical
 * lowercase form that `@blackwing/ids` `newId()` produces and Postgres returns for `uuid` columns.
 */

/** A canonical lowercase UUIDv7 (RFC 9562 §5.7): version nibble `7`, variant `8`-`b`. */
export const uuidV7Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'must be a lowercase UUIDv7',
  );

/**
 * An ISO-8601 UTC timestamp with millisecond precision and a `Z` suffix, e.g.
 * `2026-01-01T00:00:00.000Z`: the only wire format for instants (§5, FOUND-011 `@blackwing/time`).
 */
export const isoDateTimeSchema = z.iso.datetime({ precision: 3, offset: false, local: false });

/** A short, non-empty, trimmed human label (titles, names). */
export const labelSchema = z
  .string()
  .min(1)
  .max(LIMITS.labelMax)
  .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace');

/** A CWE identifier such as `CWE-89`. */
export const cweIdSchema = z.string().regex(/^CWE-[1-9][0-9]{0,4}$/, 'must look like CWE-<number>');

/** Lowercase hex SHA-256 digest. */
export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 digest');

/** `created_at` / `updated_at`, present on every table (§7 rules). */
export const timestampsShape = {
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
} as const;

/** Adds the "updatedAt is not before createdAt" rule to an entity schema check. */
export function checkTimestamps(
  value: { readonly createdAt: string; readonly updatedAt: string },
  ctx: z.RefinementCtx,
): void {
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'updatedAt must not be before createdAt',
    });
  }
}

/** True when the given ISO strings are ordered `earlier < later`. */
export function isBefore(earlier: string, later: string): boolean {
  return Date.parse(earlier) < Date.parse(later);
}
