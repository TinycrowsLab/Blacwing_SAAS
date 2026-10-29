import { ValidationError } from '@blackwing/errors';

import type { EvidenceKind, EvidenceRole } from '@blackwing/contracts';

/** One piece of evidence a Confirmed finding must carry. */
export interface RequiredEvidence {
  readonly kind: EvidenceKind;
  readonly role: EvidenceRole;
}

/** The positive request and response, and the same pair for the negative control (§3.2 step 9). */
const REPLAY_PAIR: readonly RequiredEvidence[] = [
  { kind: 'request', role: 'positive' },
  { kind: 'response', role: 'positive' },
  { kind: 'request', role: 'negative_control' },
  { kind: 'response', role: 'negative_control' },
];

/**
 * The minimum evidence set for a Confirmed finding, per oracle. The replay pair always applies. The OOB oracle also
 * needs its own stored interaction: with none, it cannot be confirmed (consistent with VALIDATE-005).
 */
export function requiredEvidence(oracleType: string): readonly RequiredEvidence[] {
  if (oracleType === 'oob') return [...REPLAY_PAIR, { kind: 'oob_interaction', role: 'oracle' }];
  return REPLAY_PAIR;
}

/**
 * Refuses a Confirmed finding whose evidence lacks any required item. Only the missing kinds and roles are named,
 * never the item ids, so the error carries no reference a caller could probe with.
 */
export function assertMinimumEvidenceSet(
  oracleType: string,
  items: readonly { readonly kind: string; readonly role: string }[],
): void {
  const present = new Set(items.map((item) => `${item.role}:${item.kind}`));
  const missing = requiredEvidence(oracleType).filter(
    (required) => !present.has(`${required.role}:${required.kind}`),
  );
  if (missing.length === 0) return;
  const list = missing.map((required) => `${required.role}:${required.kind}`).join(', ');
  throw new ValidationError('a confirmed finding needs its minimum evidence set', {
    detail: `Missing evidence: ${list}.`,
  });
}
