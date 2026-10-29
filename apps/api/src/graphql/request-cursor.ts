import { z } from 'zod';

import { ValidationError } from '@blackwing/errors';

import type { AssessmentRequestPosition } from './store.js';

/**
 * Opaque Relay cursor of an assessment-request page (API-009 pagination). It carries the keyset position of a
 * row (`createdAt`, `id`). It is not a credential: a forged cursor only moves the page, and the tenant filter,
 * RLS and the draft visibility rule still bound every row it can reach.
 */
const cursorPayload = z.strictObject({
  c: z.iso.datetime(),
  i: z.uuid(),
});

export function encodeRequestCursor(row: {
  readonly createdAt: Date;
  readonly id: string;
}): string {
  return Buffer.from(
    JSON.stringify({ c: row.createdAt.toISOString(), i: row.id }),
    'utf8',
  ).toString('base64url');
}

/** Parses a cursor from the client. Anything else is a validation error (never a partial position). */
export function decodeRequestCursor(cursor: string): AssessmentRequestPosition {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('invalid cursor');
  }
  const parsed = cursorPayload.safeParse(raw);
  if (!parsed.success) throw new ValidationError('invalid cursor');
  return { createdAt: new Date(parsed.data.c), id: parsed.data.i };
}
