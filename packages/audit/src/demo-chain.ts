// DEMO-STORY audit ledger rules: a SHA-256 hash chain over demo.audit_events. Pure functions, no IO.
// Payloads are flat (string, number, boolean or null), so jsonb key reordering cannot change a hash.
import { createHash } from 'node:crypto';

const SHA256_HEX_LENGTH = 64;
export const GENESIS = '0'.repeat(SHA256_HEX_LENGTH);

export type AuditPayload = Record<string, string | number | boolean | null>;

/** What the chain hash covers: the entry as written, with the position and time the ledger gave it. */
export interface AuditFields {
  readonly seq: number;
  readonly at: Date;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly payload: AuditPayload;
}

export interface AuditRef {
  readonly eventId: string;
  readonly hash: string;
}

export interface ChainState {
  readonly verified: boolean;
  readonly count: number;
  readonly brokenAtSeq: number | null;
}

const canonical = (payload: AuditPayload): string =>
  JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1))));

export function auditHash(prevHash: string, e: AuditFields): string {
  return createHash('sha256')
    .update(
      [
        prevHash,
        String(e.seq),
        e.at.toISOString(),
        e.actorId ?? '',
        e.actorName,
        e.action,
        e.targetType,
        e.targetId,
        canonical(e.payload),
      ].join('\n'),
    )
    .digest('hex');
}

/** Checks rows in seq order: contiguous from 1, each prev_hash is the previous hash, each hash recomputes. */
export function verifyChain(rows: readonly (AuditFields & { prevHash: string; hash: string })[]): ChainState {
  let prev = GENESIS;
  for (const [index, row] of rows.entries()) {
    if (row.seq !== index + 1 || row.prevHash !== prev || auditHash(prev, row) !== row.hash) {
      return { verified: false, count: rows.length, brokenAtSeq: row.seq };
    }
    prev = row.hash;
  }
  return { verified: true, count: rows.length, brokenAtSeq: null };
}
