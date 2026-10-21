import { z } from 'zod';

/** Longest stored header value; the replayed headers are a small allowlist, never unbounded input. */
const HEADER_VALUE_MAX = 2048;

/** Statuses a stored result can carry: success and (deterministic) client errors. */
const MIN_RESULT_STATUS = 200;
const MAX_RESULT_STATUS = 499;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const inProgressSchema = z.object({
  state: z.literal('in_progress'),
  keyHash: hex64,
  fingerprint: hex64,
  /** Random owner token: only the request that took the lock may complete or release it. */
  token: z.string().min(1),
  startedAt: z.string().min(1),
});

/** A response stored for replay. */
const storedResultSchema = z.object({
  kind: z.literal('stored'),
  status: z.number().int().min(MIN_RESULT_STATUS).max(MAX_RESULT_STATUS),
  /** The replayed header subset (`content-type`, `location`, `etag`, ...). */
  headers: z.record(z.string(), z.string().max(HEADER_VALUE_MAX)),
  body: z.string(),
});

/**
 * A completed request whose body is not kept: too large, or not text/JSON so it cannot be redacted
 * (§8.7). The key still pins the request, and replay answers `409 idempotency_result_too_large`.
 */
const omittedResultSchema = z.object({
  kind: z.literal('omitted'),
  status: z.number().int().min(MIN_RESULT_STATUS).max(MAX_RESULT_STATUS),
  reason: z.enum(['too_large', 'unsupported_type']),
});

const completedSchema = z.object({
  state: z.literal('completed'),
  keyHash: hex64,
  fingerprint: hex64,
  result: z.discriminatedUnion('kind', [storedResultSchema, omittedResultSchema]),
  completedAt: z.string().min(1),
});

/** What is stored under one `idem:{tenantId}:{route}:{sha256(key)}` key. */
export const idempotencyRecordSchema = z.discriminatedUnion('state', [
  inProgressSchema,
  completedSchema,
]);

export type InProgressRecord = z.infer<typeof inProgressSchema>;
export type CompletedRecord = z.infer<typeof completedSchema>;
export type StoredResult = z.infer<typeof storedResultSchema>;
export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;
