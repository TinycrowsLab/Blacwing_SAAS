import { z } from 'zod';

import {
  auditActionSchema,
  auditOutcomeSchema,
  auditSeveritySchema,
  killEventSchema,
  killTriggerResponseSchema,
} from '@blackwing/contracts';

import type { OperationId } from './generated/operations.js';

/** The kill event as `GET /v1/kill/{id}` serves it: the `id` field is named `killEventId` on the wire. */
const killEventViewSchema = z.preprocess((value: unknown) => {
  if (typeof value !== 'object' || value === null || !('killEventId' in value)) return value;
  const { killEventId, ...rest } = value;
  return { ...rest, id: killEventId };
}, killEventSchema);

/** One ledger row as `GET /v1/audit/events` serves it (`AuditEventView`); the other fields are not re-checked here. */
const auditEventViewSchema = z.looseObject({
  id: z.uuid(),
  seq: z.int().min(1),
  occurredAt: z.iso.datetime(),
  action: auditActionSchema,
  severity: auditSeveritySchema,
  outcome: auditOutcomeSchema,
});

/** One page of the audit ledger, newest first; `nextCursor` is absent on the last page. */
const auditEventsPageSchema = z.looseObject({
  items: z.array(auditEventViewSchema),
  nextCursor: z.string().min(1).optional(),
});

/**
 * Zod schema per successful status of every operation (non-prod response validation). The record is
 * keyed by every `OperationId`, so an operation added to the spec fails to compile until it is mapped.
 */
export const RESPONSE_SCHEMAS: Readonly<
  Record<OperationId, Readonly<Partial<Record<number, z.ZodType>>>>
> = {
  getKillEvent: { 200: killEventViewSchema },
  listAuditEvents: { 200: auditEventsPageSchema },
  // text/event-stream, not JSON: there is no body schema to check, so the client returns it unparsed.
  streamRunEvents: {},
  triggerKill: { 202: killTriggerResponseSchema },
};
