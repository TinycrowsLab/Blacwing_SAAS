// Notification routing rule persistence (NOTIFY-011, CONTEXT_PACK §8.6, §8.8). Every method runs through
// `withTenant`, so RLS confines it and a missing tenant context fails closed. A write locks the rule row,
// applies the change and writes its audit event in the same transaction: a change that cannot be audited does
// not happen. A rule names its channel by id and holds no credential.

import { and, asc, eq } from 'drizzle-orm';

import { notificationRoutes, type NotificationRouteRow } from './schema/notifications.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';
import type {
  NotificationRouteEvent,
  NotificationRouteRecipientSpec,
  NotificationSeverity,
} from '@blackwing/contracts';

/** Longest rule list one call returns. A tenant with more rules pages through the console, not here. */
export const NOTIFICATION_ROUTE_LIST_LIMIT = 200;

/** What a create commits. */
export interface NewRouteWrite {
  readonly id: string;
  readonly event: NotificationRouteEvent;
  readonly assetId: string | null;
  readonly severityMin: NotificationSeverity;
  readonly channelId: string;
  readonly recipientSpec: NotificationRouteRecipientSpec;
  readonly enabled: boolean;
  readonly priority: number;
  readonly createdBy: string;
}

/** What an update commits. Absent fields keep their stored value. */
export interface RouteUpdateWrite {
  readonly event?: NotificationRouteEvent;
  readonly assetId?: string | null;
  readonly severityMin?: NotificationSeverity;
  readonly channelId?: string;
  readonly recipientSpec?: NotificationRouteRecipientSpec;
  readonly enabled?: boolean;
  readonly priority?: number;
  /** Field names that changed, for the audit event. Never values. */
  readonly changedFields: readonly string[];
  readonly op: NotificationRouteOp;
  readonly actorId: string;
}

export type NotificationRouteOp = 'created' | 'updated' | 'deleted';

/** The audit event of a committed rule change (`notification.route_changed`), in the write's transaction. */
export interface NotificationRouteAuditEvent {
  readonly action: 'notification.route_changed';
  readonly tenantId: string;
  readonly actorId: string;
  readonly routeId: string;
  readonly op: NotificationRouteOp;
  readonly changedFields: readonly string[];
}

/** Audit hook (§8.8): runs inside the write's transaction, so a failure rolls the change back. */
export type NotificationRouteAuditHook = (
  event: NotificationRouteAuditEvent,
  tx: TenantTx,
) => void | Promise<void>;

export interface NotificationRouteRepositoryOptions {
  readonly db: Database;
  readonly audit: NotificationRouteAuditHook;
}

/** Tenant-scoped persistence of notification routing rules. */
export class NotificationRouteRepository {
  constructor(private readonly options: NotificationRouteRepositoryOptions) {}

  /** The rules of `tenantId`, in id order. Empty when the tenant has none (or RLS hides them). */
  async list(tenantId: string): Promise<readonly NotificationRouteRow[]> {
    return withTenant(this.options.db, tenantId, (tx) =>
      tx
        .select()
        .from(notificationRoutes)
        .where(eq(notificationRoutes.tenantId, tenantId))
        .orderBy(asc(notificationRoutes.id))
        .limit(NOTIFICATION_ROUTE_LIST_LIMIT),
    );
  }

  /** One rule of `tenantId`, or `undefined` when it does not exist there (RLS and the filter). */
  async find(tenantId: string, routeId: string): Promise<NotificationRouteRow | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(notificationRoutes)
        .where(and(eq(notificationRoutes.tenantId, tenantId), eq(notificationRoutes.id, routeId)))
        .limit(1);
      return rows[0];
    });
  }

  /** The ids of the enabled rules of `tenantId` that name `channelId`: the rules that block a channel's delete. */
  async enabledRuleIdsForChannel(tenantId: string, channelId: string): Promise<readonly string[]> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ id: notificationRoutes.id })
        .from(notificationRoutes)
        .where(
          and(
            eq(notificationRoutes.tenantId, tenantId),
            eq(notificationRoutes.channelId, channelId),
            eq(notificationRoutes.enabled, true),
          ),
        )
        .orderBy(asc(notificationRoutes.id));
      return rows.map((row) => row.id);
    });
  }

  /** Commits a new rule and its audit event together. */
  async create(tenantId: string, write: NewRouteWrite): Promise<NotificationRouteRow> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(notificationRoutes)
        .values({
          id: write.id,
          tenantId,
          event: write.event,
          assetId: write.assetId,
          severityMin: write.severityMin,
          channelId: write.channelId,
          recipientSpec: write.recipientSpec,
          enabled: write.enabled,
          priority: write.priority,
          createdBy: write.createdBy,
        })
        .returning();
      if (row === undefined) throw new Error('route insert produced no row');
      await this.options.audit(
        {
          action: 'notification.route_changed',
          tenantId,
          actorId: write.createdBy,
          routeId: row.id,
          op: 'created',
          changedFields: [
            'event',
            'assetId',
            'severityMin',
            'channelId',
            'recipientSpec',
            'enabled',
            'priority',
          ],
        },
        tx,
      );
      return row;
    });
  }

  /**
   * Runs `mutate` on the locked rule. It returns the write to commit, or `undefined` for a no-op (nothing is
   * written or audited). `undefined` also means the rule is gone in this tenant.
   */
  async update(
    tenantId: string,
    routeId: string,
    mutate: (current: NotificationRouteRow) => RouteUpdateWrite | undefined,
  ): Promise<{ readonly record: NotificationRouteRow; readonly changed: boolean } | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const [current] = await tx
        .select()
        .from(notificationRoutes)
        .where(and(eq(notificationRoutes.tenantId, tenantId), eq(notificationRoutes.id, routeId)))
        .limit(1)
        .for('update');
      if (current === undefined) return undefined;
      const write = mutate(current);
      if (write === undefined) return { record: current, changed: false };
      const [record] = await tx
        .update(notificationRoutes)
        .set({
          ...(write.event === undefined ? {} : { event: write.event }),
          ...(write.assetId === undefined ? {} : { assetId: write.assetId }),
          ...(write.severityMin === undefined ? {} : { severityMin: write.severityMin }),
          ...(write.channelId === undefined ? {} : { channelId: write.channelId }),
          ...(write.recipientSpec === undefined ? {} : { recipientSpec: write.recipientSpec }),
          ...(write.enabled === undefined ? {} : { enabled: write.enabled }),
          ...(write.priority === undefined ? {} : { priority: write.priority }),
        })
        .where(and(eq(notificationRoutes.tenantId, tenantId), eq(notificationRoutes.id, routeId)))
        .returning();
      if (record === undefined) throw new Error('route update produced no row');
      await this.options.audit(
        {
          action: 'notification.route_changed',
          tenantId,
          actorId: write.actorId,
          routeId,
          op: write.op,
          changedFields: write.changedFields,
        },
        tx,
      );
      return { record, changed: true };
    });
  }

  /** Deletes the rule and commits its audit event in the same transaction. Returns the deleted row, if any. */
  async remove(
    tenantId: string,
    routeId: string,
    actorId: string,
  ): Promise<NotificationRouteRow | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const [row] = await tx
        .delete(notificationRoutes)
        .where(and(eq(notificationRoutes.tenantId, tenantId), eq(notificationRoutes.id, routeId)))
        .returning();
      if (row === undefined) return undefined;
      await this.options.audit(
        {
          action: 'notification.route_changed',
          tenantId,
          actorId,
          routeId,
          op: 'deleted',
          changedFields: [],
        },
        tx,
      );
      return row;
    });
  }
}
