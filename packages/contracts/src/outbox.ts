import { z } from 'zod';

import { LIMITS } from './limits.js';
import { sha256HexSchema, uuidV7Schema } from './primitives.js';

/**
 * Transactional outbox contracts (WORKFLOW-001 follow-up, F12, F34, CONTEXT_PACK §7, §8.8).
 *
 * A domain write and the side effects it implies (audit events, notifications, workflow signals)
 * commit in one Postgres transaction as `outbox` rows; the relay (WORKFLOW-012) delivers them at least
 * once. This module fixes what a producer may enqueue. The table lives in `@blackwing/db`, whose
 * `withOutbox` helper is the only writer; the value lists and the payload cap below are the single
 * source for its check constraints.
 *
 * Rules that are part of the contract:
 * - There is no tenant on a message. The row's tenant is always the transaction's active
 *   `app.tenant_id`, so a producer cannot enqueue into another tenant (§8.6).
 * - There is no `availableAt`. Delivery time is the database clock (`now()`), never a caller clock.
 * - Payloads carry references (secret ref ids, evidence keys), never secret values (§8.7). The helper
 *   redacts as a safety net; producers redact first.
 * - A payload is at most {@link OUTBOX_PAYLOAD_MAX_BYTES} bytes as Postgres renders the jsonb. A larger
 *   body goes to object storage and the message carries {@link outboxPayloadRefSchema} instead.
 */

/** What the relay does with a row: write an audit event, send a notification, signal a workflow. */
export const OUTBOX_MESSAGE_TYPES = ['audit.event', 'notify.send', 'temporal.signal'] as const;
export const outboxMessageTypeSchema = z.enum(OUTBOX_MESSAGE_TYPES);
export type OutboxMessageType = z.infer<typeof outboxMessageTypeSchema>;

/** Delivery state of an outbox row. */
export const OUTBOX_STATUSES = ['pending', 'dispatched', 'failed'] as const;
export const outboxStatusSchema = z.enum(OUTBOX_STATUSES);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

/** Largest payload, as Postgres renders the jsonb as text, in UTF-8 bytes (64 KiB). */
export const OUTBOX_PAYLOAD_MAX_BYTES = 65_536;

/** Deepest payload nesting accepted (the object itself is depth 1). */
export const OUTBOX_PAYLOAD_MAX_DEPTH = 16;

/** Most messages one `withOutbox` call may enqueue. */
export const OUTBOX_BATCH_MAX = 500;

/** Longest `dedupe_key`. */
export const OUTBOX_DEDUPE_KEY_MAX = 255;

/** Upper bound of the characters a finite double takes once Postgres expands an exponent form. */
const EXPANDED_NUMBER_MAX = 330;

/** `null` and `true` render as 4 bytes, `false` as 5. */
const NULL_BYTES = 4;
const TRUE_BYTES = 4;
const FALSE_BYTES = 5;

const encoder = new TextEncoder();

/**
 * Size in UTF-8 bytes of `value` as `jsonb::text` renders it (`{"a": 1, "b": [1, 2]}`: one space
 * after each `:` and `,`). Postgres is the authority for the stored size, so this mirrors its output
 * format and rounds numbers in exponent form up, so it never under-counts: a payload this accepts
 * also passes the `outbox_payload_size_check` constraint. Returns `Infinity` past
 * {@link OUTBOX_PAYLOAD_MAX_DEPTH}.
 */
export function outboxPayloadBytes(value: unknown, depth = 0): number {
  if (value === null) return NULL_BYTES;
  switch (typeof value) {
    case 'boolean':
      return value ? TRUE_BYTES : FALSE_BYTES;
    case 'number': {
      const text = String(value);
      return /e/i.test(text) ? EXPANDED_NUMBER_MAX : text.length;
    }
    case 'string':
      return encoder.encode(JSON.stringify(value)).byteLength;
    case 'object': {
      if (depth >= OUTBOX_PAYLOAD_MAX_DEPTH) return Number.POSITIVE_INFINITY;
      if (Array.isArray(value)) {
        let total = 2 + Math.max(0, value.length - 1) * 2;
        for (const item of value) total += outboxPayloadBytes(item, depth + 1);
        return total;
      }
      const entries = Object.entries(value);
      let total = 2 + Math.max(0, entries.length - 1) * 2;
      for (const [key, item] of entries) {
        total += encoder.encode(JSON.stringify(key)).byteLength + 2;
        total += outboxPayloadBytes(item, depth + 1);
      }
      return total;
    }
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/** A JSON object payload that fits the cap. Oversized bodies are stored elsewhere and referenced. */
export const outboxPayloadSchema = z
  .record(z.string(), z.json())
  .refine(
    (payload) => outboxPayloadBytes(payload) <= OUTBOX_PAYLOAD_MAX_BYTES,
    `payload must be at most ${OUTBOX_PAYLOAD_MAX_BYTES} bytes and ${OUTBOX_PAYLOAD_MAX_DEPTH} levels deep: store the body in object storage and enqueue a payloadRef`,
  );
export type OutboxPayload = z.infer<typeof outboxPayloadSchema>;

/** The pointer a message carries instead of an oversized body (object key, never the blob). */
export const outboxPayloadRefSchema = z.strictObject({
  payloadRef: z.strictObject({
    s3Key: z.string().min(1).max(LIMITS.urlMax),
    sha256: sha256HexSchema,
    sizeBytes: z.int().positive().max(LIMITS.int32Max),
  }),
});
export type OutboxPayloadRef = z.infer<typeof outboxPayloadRefSchema>;

/** One side-effect intent to enqueue with a domain write. */
export const OutboxMessageSchema = z.strictObject({
  type: outboxMessageTypeSchema,
  /** The entity kind the message is about (`run`, `standing_authorisation`). */
  aggregateType: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be a lower-case snake_case name')
    .optional(),
  aggregateId: uuidV7Schema.optional(),
  payload: outboxPayloadSchema,
  /**
   * Idempotency key, unique within the tenant: a second message with the same key is rejected, so a
   * retried producer cannot double-enqueue. Printable ASCII without spaces.
   */
  dedupeKey: z
    .string()
    .regex(
      new RegExp(`^[\\x21-\\x7e]{1,${OUTBOX_DEDUPE_KEY_MAX}}$`),
      `must be 1-${OUTBOX_DEDUPE_KEY_MAX} printable ASCII characters without spaces`,
    )
    .optional(),
});
export type OutboxMessage = z.infer<typeof OutboxMessageSchema>;
export type OutboxMessageInput = z.input<typeof OutboxMessageSchema>;

/** The batch `withOutbox` accepts: at most {@link OUTBOX_BATCH_MAX} messages. */
export const outboxMessagesSchema = z.array(OutboxMessageSchema).max(OUTBOX_BATCH_MAX);
