import { z } from 'zod';

import { ValidationError } from '@blackwing/errors';

/**
 * Opaque Relay cursor of an endpoint page (API-009 pagination). It carries the natural key of the last endpoint
 * returned, the position the keyset query resumes after. It is not a credential: a forged cursor only moves the page,
 * and the tenant pin, the run match and the run's RLS check still bound every row it can reach. It mirrors
 * `request-cursor.ts`.
 */
/** Longest natural key a cursor may carry (the contract key bound). */
const KEY_MAX = 4096;
const cursorPayload = z.strictObject({
  k: z.string().min(1).max(KEY_MAX),
});

export function encodeEndpointCursor(naturalKeyValue: string): string {
  return Buffer.from(JSON.stringify({ k: naturalKeyValue }), 'utf8').toString('base64url');
}

/** Parses a cursor from the client. Anything else is a validation error (never a partial position). */
export function decodeEndpointCursor(cursor: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('invalid cursor');
  }
  const parsed = cursorPayload.safeParse(raw);
  if (!parsed.success) throw new ValidationError('invalid cursor');
  return parsed.data.k;
}
