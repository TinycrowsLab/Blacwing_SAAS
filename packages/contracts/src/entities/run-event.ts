import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { isoDateTimeSchema } from '../primitives.js';

/** Event type: a dotted lowercase name such as `message.partial` or `tool.call`. */
export const runEventTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'must be a dotted lowercase event name')
  .max(LIMITS.keyMax);

/**
 * A live run event as carried on the run's event stream (WORKFLOW-013). Events are ephemeral
 * transport for the console live view; the durable record is the audit ledger and the evidence
 * store, so a payload carries no secrets or PII (redacted upstream) and large blobs travel by
 * reference (an evidence key), never inline.
 *
 * `seq` is assigned by the publisher; with several publishers it may be out of order, so
 * consumers sort by stream id.
 */
export const runEventSchema = z.strictObject({
  type: runEventTypeSchema,
  ts: isoDateTimeSchema,
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  payload: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.output<typeof runEventSchema>;
