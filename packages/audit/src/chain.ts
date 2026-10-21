import { createHash } from 'node:crypto';

import {
  AUDIT_GENESIS_PREV_HASH,
  AuditEventSchema,
  auditEventHashInput,
  type AuditEvent,
  type AuditEventHashed,
} from '@blackwing/contracts';
import { toTenantIsolationError } from '@blackwing/db';
import { ForbiddenError } from '@blackwing/errors';

import type { AuditEventDraft } from './draft.js';
import type { AuditSqlTx } from './ports.js';

/** The tip of one tenant's chain. An empty chain has `seq` 0 and no hash. */
export interface AuditChainHead {
  readonly seq: number;
  readonly hash: Buffer | null;
}

/** A ledger row as stored: hashes are raw bytes, `prevHash` is NULL on the genesis row. */
export interface AuditChainRow {
  readonly event: AuditEvent;
  readonly prevHash: Buffer | null;
  readonly hash: Buffer;
}

/**
 * The storage the appender runs against. `head` must take the per-tenant lock (Postgres:
 * `bw_audit_chain_head`) and hold it until the transaction ends, so concurrent appenders of one
 * tenant serialise; `insert` and `exists` run in that same transaction.
 */
export interface AuditChainStore {
  head(tenantId: string): Promise<AuditChainHead>;
  exists(tenantId: string, eventId: string): Promise<boolean>;
  insert(row: AuditChainRow): Promise<void>;
}

export interface AppendResult {
  /** The stored event, or `undefined` when an event with this id was already in the chain. */
  readonly event: AuditEvent | undefined;
  readonly appended: boolean;
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/**
 * Appends a draft to its tenant's chain through `store`. A pure function of `(store, draft)`: the
 * synchronous caller path and the outbox relay both come through here, so both chain identically.
 *
 * Takes the tenant lock first (via `head`), then drops a draft whose id is already in the ledger (a
 * retried producer or relay: exactly one row), otherwise sets `seq = head + 1`,
 * `prevHash = head hash` and `hash = SHA-256(JCS(event without hash))`, re-validates the complete
 * event and inserts it. Any failure propagates: the caller's transaction rolls back.
 */
export async function appendToChain(
  store: AuditChainStore,
  draft: AuditEventDraft,
): Promise<AppendResult> {
  const head = await store.head(draft.tenantId);
  if (await store.exists(draft.tenantId, draft.id)) {
    return { event: undefined, appended: false };
  }
  const prevHash = head.hash;
  const unhashed: AuditEventHashed = {
    ...draft,
    seq: head.seq + 1,
    prevHash: prevHash === null ? AUDIT_GENESIS_PREV_HASH : prevHash.toString('hex'),
  };
  const hash = sha256(auditEventHashInput(unhashed));
  const event = AuditEventSchema.parse({ ...unhashed, hash: hash.toString('hex') });
  await store.insert({ event, prevHash, hash });
  return { event, appended: true };
}

const INSERT_SQL = `INSERT INTO audit_events (
  id, tenant_id, seq, occurred_at, action, severity, actor, target, outcome, reason, metadata,
  metadata_ref, trace_id, run_id, ip, user_agent, prev_hash, hash
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb,
  $12::jsonb, $13, $14, $15, $16, $17, $18)`;

const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

/** Maps tenant-isolation failures to AppErrors; everything else propagates unchanged. */
function translate(error: unknown): unknown {
  const mapped = toTenantIsolationError(error);
  if (mapped !== undefined) return mapped;
  if ((error as { code?: unknown } | null)?.code === '42501') {
    return new ForbiddenError('audit event tenant differs from the session tenant', {
      cause: error,
    });
  }
  return error;
}

/** The Postgres store over the caller's transaction (see migration `audit_events`). */
export function createPgChainStore(tx: AuditSqlTx): AuditChainStore {
  return {
    async head(tenantId) {
      try {
        const result = await tx.query('SELECT head_seq, head_hash FROM bw_audit_chain_head($1)', [
          tenantId,
        ]);
        const row = result.rows[0];
        if (row === undefined) throw new Error('bw_audit_chain_head returned no row');
        return { seq: Number(row.head_seq), hash: (row.head_hash ?? null) as Buffer | null };
      } catch (error) {
        throw translate(error);
      }
    },
    async exists(tenantId, eventId) {
      try {
        const result = await tx.query(
          'SELECT 1 AS found FROM audit_events WHERE tenant_id = $1 AND id = $2',
          [tenantId, eventId],
        );
        return result.rows.length > 0;
      } catch (error) {
        throw translate(error);
      }
    },
    async insert({ event, prevHash, hash }) {
      try {
        await tx.query(INSERT_SQL, [
          event.id,
          event.tenantId,
          event.seq,
          event.occurredAt,
          event.action,
          event.severity,
          JSON.stringify(event.actor),
          JSON.stringify(event.target),
          event.outcome,
          event.reason ?? null,
          JSON.stringify(event.metadata),
          json(event.metadataRef),
          event.traceId ?? null,
          event.runId ?? null,
          event.ip ?? null,
          event.userAgent ?? null,
          prevHash,
          hash,
        ]);
      } catch (error) {
        throw translate(error);
      }
    },
  };
}
