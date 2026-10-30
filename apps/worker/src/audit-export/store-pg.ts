import { and, asc, eq, gt, sql } from 'drizzle-orm';

import { AUDIT_GENESIS_PREV_HASH, AuditEventSchema, type AuditEvent } from '@blackwing/contracts';
import {
  auditEvents,
  auditExportSubscriptions,
  type AuditExportSubscriptionRow,
  type AuditEventRow,
  type Database,
  withTenant,
} from '@blackwing/db';

import type { AuditExportStore, AuditExportSubscription } from '@blackwing/audit';

/**
 * The Postgres store of the SIEM export (AUDIT-004). Every call runs in one tenant transaction (`withTenant`, RLS,
 * fail closed). The cursor moves by compare-and-set on the value the caller read, and the database refuses a rewind.
 */

function toSubscription(row: AuditExportSubscriptionRow): AuditExportSubscription {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    config: row.config,
    secretRef: row.secretRef,
    cursorSeq: row.cursorSeq,
    status: row.status,
    filters: row.filters,
  };
}

/** Rebuilds the canonical event from its row (the hash bytes back to hex; a NULL `prev_hash` is the genesis). */
function toLedgerEvent(row: AuditEventRow): AuditEvent {
  return AuditEventSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    seq: row.seq,
    occurredAt: row.occurredAt.toISOString(),
    action: row.action,
    severity: row.severity,
    actor: row.actor,
    target: row.target,
    outcome: row.outcome,
    ...(row.reason === null ? {} : { reason: row.reason }),
    metadata: row.metadata,
    ...(row.metadataRef === null ? {} : { metadataRef: row.metadataRef }),
    ...(row.traceId === null ? {} : { traceId: row.traceId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    ...(row.ip === null ? {} : { ip: row.ip }),
    ...(row.userAgent === null ? {} : { userAgent: row.userAgent }),
    prevHash: row.prevHash === null ? AUDIT_GENESIS_PREV_HASH : row.prevHash.toString('hex'),
    hash: row.hash.toString('hex'),
  });
}

export function createPgAuditExportStore(db: Database): AuditExportStore {
  return {
    async load(tenantId, subscriptionId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(auditExportSubscriptions)
          .where(eq(auditExportSubscriptions.id, subscriptionId))
          .limit(1);
        return row === undefined ? undefined : toSubscription(row);
      });
    },

    async headSeq(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        // `::int` keeps the head a JS number (a bigint max would come back as a string).
        const [row] = await tx
          .select({ head: sql<number>`coalesce(max(${auditEvents.seq}), 0)::int` })
          .from(auditEvents);
        return row?.head ?? 0;
      });
    },

    async readEvents(tenantId, afterSeq, limit) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantId), gt(auditEvents.seq, afterSeq)))
          .orderBy(asc(auditEvents.seq))
          .limit(limit);
        return rows.map((row) => toLedgerEvent(row));
      });
    },

    async advanceCursor({ tenantId, subscriptionId, from, to }) {
      return withTenant(db, tenantId, async (tx) => {
        const moved = await tx
          .update(auditExportSubscriptions)
          .set({ cursorSeq: to })
          .where(
            and(
              eq(auditExportSubscriptions.id, subscriptionId),
              eq(auditExportSubscriptions.cursorSeq, from),
            ),
          )
          .returning({ id: auditExportSubscriptions.id });
        return moved.length === 1;
      });
    },

    async setStatus({ tenantId, subscriptionId, status }) {
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .update(auditExportSubscriptions)
          .set({ status })
          .where(eq(auditExportSubscriptions.id, subscriptionId));
      });
    },
  };
}
