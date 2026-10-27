import { z } from 'zod';

import { killEventSchema, killTriggerResponseSchema } from '@blackwing/contracts';

import type { OperationId } from './generated/operations.js';

/** The kill event as `GET /v1/kill/{id}` serves it: the `id` field is named `killEventId` on the wire. */
const killEventViewSchema = z.preprocess((value: unknown) => {
  if (typeof value !== 'object' || value === null || !('killEventId' in value)) return value;
  const { killEventId, ...rest } = value;
  return { ...rest, id: killEventId };
}, killEventSchema);

/**
 * Zod schema per successful status of every operation (non-prod response validation). The record is
 * keyed by every `OperationId`, so an operation added to the spec fails to compile until it is mapped.
 */
export const RESPONSE_SCHEMAS: Readonly<
  Record<OperationId, Readonly<Partial<Record<number, z.ZodType>>>>
> = {
  getKillEvent: { 200: killEventViewSchema },
  triggerKill: { 202: killTriggerResponseSchema },
};
