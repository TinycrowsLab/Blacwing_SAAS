import type { NotificationChannelStore } from '../notification-channels/ports.js';
import type { NewRouteWrite, NotificationRouteRow, RouteUpdateWrite } from '@blackwing/db';

/**
 * Routing rule persistence (the Postgres adapter is `NotificationRouteRepository` in @blackwing/db). `update` runs
 * `mutate` on the locked row; `undefined` from it writes nothing. A write and its audit event commit together.
 */
export interface NotificationRouteStore {
  list(tenantId: string): Promise<readonly NotificationRouteRow[]>;
  find(tenantId: string, routeId: string): Promise<NotificationRouteRow | undefined>;
  create(tenantId: string, write: NewRouteWrite): Promise<NotificationRouteRow>;
  update(
    tenantId: string,
    routeId: string,
    mutate: (current: NotificationRouteRow) => RouteUpdateWrite | undefined,
  ): Promise<{ readonly record: NotificationRouteRow; readonly changed: boolean } | undefined>;
  remove(
    tenantId: string,
    routeId: string,
    actorId: string,
  ): Promise<NotificationRouteRow | undefined>;
  enabledRuleIdsForChannel(tenantId: string, channelId: string): Promise<readonly string[]>;
}

/** Looks a channel up in the tenant, so a rule can be refused when it names a missing or disabled channel. */
export type RouteChannelLookup = Pick<NotificationChannelStore, 'find'>;
