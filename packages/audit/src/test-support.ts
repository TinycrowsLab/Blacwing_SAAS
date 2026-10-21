// In-memory fakes shared by the unit tests: a chain store enforcing the same rules as the
// `audit_events` triggers (gapless seq, prev_hash = head hash), and a recording outbox.

import { createHash } from 'node:crypto';

import {
  AUDIT_GENESIS_PREV_HASH,
  auditEventHashInput,
  type AuditEvent,
} from '@blackwing/contracts';

import type { AuditChainRow, AuditChainStore } from './chain.js';
import type { AuditOutbox, AuditOutboxMessage, AuditSqlTx } from './ports.js';

export const TENANT_A = '01900000-0000-7000-8000-000000000001';
export const TENANT_B = '01900000-0000-7000-8000-000000000002';
export const RUN_ID = '01900000-0000-7000-8000-0000000000b1';
export const SECRET = 'hunter2-s3cr3t-value';

export class MemoryLedger {
  readonly rows: AuditChainRow[] = [];

  store(): AuditChainStore {
    return {
      head: (tenantId) => {
        const mine = this.rows.filter((row) => row.event.tenantId === tenantId);
        const last = mine.at(-1);
        return Promise.resolve({ seq: last?.event.seq ?? 0, hash: last?.hash ?? null });
      },
      exists: (tenantId, eventId) =>
        Promise.resolve(
          this.rows.some((row) => row.event.tenantId === tenantId && row.event.id === eventId),
        ),
      insert: (row) => {
        const mine = this.rows.filter((r) => r.event.tenantId === row.event.tenantId);
        const last = mine.at(-1);
        const wantPrev = last?.hash ?? null;
        const same =
          row.prevHash === null
            ? wantPrev === null
            : row.prevHash.equals(wantPrev ?? Buffer.alloc(0));
        if (row.event.seq !== (last?.event.seq ?? 0) + 1 || !same) {
          return Promise.reject(new Error('audit chain violation'));
        }
        this.rows.push(row);
        return Promise.resolve();
      },
    };
  }

  forTenant(tenantId: string): AuditEvent[] {
    return this.rows.filter((r) => r.event.tenantId === tenantId).map((r) => r.event);
  }
}

/** Recomputes the hash chain of `events` (one tenant, in order); returns the sequence numbers. */
export function verifyEvents(events: readonly AuditEvent[]): number[] {
  let previous = AUDIT_GENESIS_PREV_HASH;
  for (const event of events) {
    if (event.prevHash !== previous) throw new Error(`broken link at seq ${String(event.seq)}`);
    const { hash, ...rest } = event;
    const expected = createHash('sha256').update(auditEventHashInput(rest), 'utf8').digest('hex');
    if (hash !== expected) throw new Error(`bad hash at seq ${String(event.seq)}`);
    previous = hash;
  }
  return events.map((event) => event.seq);
}

export class MemoryOutbox implements AuditOutbox {
  readonly messages: AuditOutboxMessage[] = [];
  readonly txs: (AuditSqlTx | undefined)[] = [];
  failWith: Error | undefined;

  enqueue(message: AuditOutboxMessage, options?: { readonly tx?: AuditSqlTx }): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    // Same contract as the real outbox: unique (tenant_id, dedupe_key), a repeat is a no-op.
    if (
      !this.messages.some(
        (m) => m.tenantId === message.tenantId && m.dedupeKey === message.dedupeKey,
      )
    ) {
      this.messages.push(message);
      this.txs.push(options?.tx);
    }
    return Promise.resolve();
  }
}

/** A tx the fakes never touch; the memory chain store ignores it. */
export const NULL_TX: AuditSqlTx = { query: () => Promise.resolve({ rows: [] }) };
