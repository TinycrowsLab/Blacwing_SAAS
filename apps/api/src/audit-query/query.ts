import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  auditActionSchema,
  auditOutcomeSchema,
  canonicalJson,
  uuidV7Schema,
} from '@blackwing/contracts';
import { AppError, ValidationError } from '@blackwing/errors';

import type { AuditEventFilters } from './ports.js';

/** Largest page a client may request (§9). */
export const AUDIT_QUERY_LIMIT_MAX = 200;
/** Page size when the client sends no `limit`. */
export const AUDIT_QUERY_LIMIT_DEFAULT = 50;

/** Actor, target and token ids: printable ASCII without spaces, the ledger's identifier alphabet (AUDIT-001). */
const identifierFilter = z
  .string()
  .regex(/^[\x21-\x7e]{1,255}$/, 'must be 1-255 printable ASCII characters without spaces');

/** `true` or `false` only: anything else is a validation error, never a silent default. */
const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Query strings arrive as text; a page size is a whole number from 1 to the maximum. */
const limitParam = z
  .string()
  .regex(/^[1-9]\d{0,2}$/, 'must be a whole number')
  .transform(Number)
  .pipe(z.number().max(AUDIT_QUERY_LIMIT_MAX));

/**
 * `GET /v1/audit/events` query string (#86). `strictObject` refuses unknown keys, so a misspelt filter
 * fails instead of silently returning everything. Timestamps must carry `Z` (UTC): naive local times
 * are refused rather than guessed.
 */
export const auditEventsQuerySchema = z
  .strictObject({
    actorId: identifierFilter.optional(),
    action: auditActionSchema.optional(),
    targetId: identifierFilter.optional(),
    runId: uuidV7Schema.optional(),
    outcome: auditOutcomeSchema.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    includeChain: booleanFlag.optional(),
    cursor: z.string().optional(),
    limit: limitParam.optional(),
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      Date.parse(query.from) <= Date.parse(query.to),
    { message: 'from must not be after to', path: ['from'] },
  );

/** A query after validation: the filters, the chain flag, the raw cursor and the page size. */
export interface ParsedAuditEventsQuery {
  readonly filters: AuditEventFilters;
  readonly includeChain: boolean;
  readonly cursor: string | undefined;
  readonly limit: number;
}

/** Validates the raw query. Every failure is a `VALIDATION_FAILED` (422) with the first issue as detail. */
export function parseAuditEventsQuery(raw: unknown): ParsedAuditEventsQuery {
  const result = auditEventsQuerySchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? '' : `${issue.path.join('.') || 'query'}: `;
    throw new ValidationError('invalid audit query', {
      detail: `${where}${issue?.message ?? 'invalid'}`,
    });
  }
  const query = result.data;
  const filters: AuditEventFilters = {
    ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
    ...(query.action === undefined ? {} : { action: query.action }),
    ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
    ...(query.runId === undefined ? {} : { runId: query.runId }),
    ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
    ...(query.from === undefined ? {} : { from: query.from }),
    ...(query.to === undefined ? {} : { to: query.to }),
  };
  return {
    filters,
    includeChain: query.includeChain ?? false,
    cursor: query.cursor,
    limit: query.limit ?? AUDIT_QUERY_LIMIT_DEFAULT,
  };
}

/**
 * Digest of the filters a cursor was issued for. A cursor replayed against other filters fails, and the
 * page size and chain flag are deliberately left out: they may change between pages.
 */
export function filterSignature(filters: AuditEventFilters): string {
  return createHash('sha256').update(canonicalJson(filters)).digest('base64url');
}

/** The cursor is malformed, forged, or was issued for other filters (400 `INVALID_CURSOR`). */
export function invalidAuditCursor(): AppError {
  return new AppError('INVALID_CURSOR', 'invalid cursor', {
    detail: 'The cursor is not valid for this request.',
  });
}
