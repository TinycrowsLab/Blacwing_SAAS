// Virtual model key authentication (GATEWAY-002, #405, CONTEXT_PACK §8.6, §8.7). Pure decision logic: the
// caller supplies the stored row through a resolver, so the domain never reaches the database. Every failure
// (malformed key, unknown hash, expired, revoked, unreadable budget context) yields `undefined`, which the
// gateway turns into one uniform 401. There is no clock leeway: expiry is strict.

import {
  VIRTUAL_KEY_PATTERN,
  virtualKeyBudgetContextSchema,
  type VirtualKeyContext,
} from '@blackwing/contracts';
import { hashVirtualKey } from '@blackwing/crypto';

/** A stored key row, reduced to what the decision needs. Never holds the raw key. */
export interface VirtualKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly persona: string;
  readonly budgetContext: Readonly<Record<string, unknown>>;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** Looks up the row whose SHA-256 is `keySha256`, or `null`. Supplied by the caller (the database). */
export type VirtualKeyResolver = (keySha256: Buffer) => Promise<VirtualKeyRecord | null>;

/** Decides whether a stored row is usable at `now`. Returns the request context, or `undefined`. */
export function evaluateVirtualKey(
  record: VirtualKeyRecord,
  now: Date,
): VirtualKeyContext | undefined {
  if (record.revokedAt !== null) return undefined;
  if (!(record.expiresAt.getTime() > now.getTime())) return undefined;
  const budget = virtualKeyBudgetContextSchema.safeParse(record.budgetContext);
  if (!budget.success) return undefined;
  return {
    virtualKeyId: record.id,
    tenantId: record.tenantId,
    runId: record.runId,
    sessionId: record.sessionId,
    persona: record.persona,
    budgetContext: budget.data,
    expiresAt: record.expiresAt.toISOString(),
  };
}

/**
 * Authenticates a presented `bwk_` key. A key that does not have the key shape is refused before any lookup,
 * so a garbage credential costs no database round trip.
 */
export async function authenticateVirtualKey(
  key: string,
  resolve: VirtualKeyResolver,
  now: Date,
): Promise<VirtualKeyContext | undefined> {
  if (!VIRTUAL_KEY_PATTERN.test(key)) return undefined;
  const record = await resolve(hashVirtualKey(key));
  if (record === null) return undefined;
  return evaluateVirtualKey(record, now);
}
