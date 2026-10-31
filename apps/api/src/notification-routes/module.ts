import { type DynamicModule, Module } from '@nestjs/common';

import { NotificationRoutesController } from './controller.js';
import { createNotificationRouteMetrics } from './metrics.js';
import { NotificationRouteService, type NotificationRouteServiceDeps } from './service.js';
import { NOTIFICATION_ROUTE_SERVICE } from './tokens.js';

import type { NotificationRouteStore } from './ports.js';
import type { ChannelReferences } from '../notification-channels/ports.js';
import type { Registry } from 'prom-client';

export interface NotificationRoutesModuleOptions extends Pick<
  NotificationRouteServiceDeps,
  'store' | 'channels' | 'memberships' | 'logger' | 'tracer'
> {
  /** Registry the `bw_notification_route_changes_total` counter lives on. */
  readonly registry: Registry;
}

/**
 * The channel references a channel delete consults (NOTIFY-001): a channel named by an enabled routing rule cannot
 * be disabled without `force`. Pass this as the channel module's `references` in the composition root.
 */
export function routeChannelReferences(store: NotificationRouteStore): ChannelReferences {
  return {
    activeRuleIds: (tenantId, channelId) => store.enabledRuleIdsForChannel(tenantId, channelId),
  };
}

/**
 * Mounts `/v1/notification-routes`. The store is the Postgres adapter of @blackwing/db; tests pass fakes. Mount it
 * through `createApiApp({ imports })` under the global tenant guard, or it answers 401 (fail closed).
 */
@Module({})
export class NotificationRoutesModule {
  static forRoot(options: NotificationRoutesModuleOptions): DynamicModule {
    const service = new NotificationRouteService({
      store: options.store,
      channels: options.channels,
      memberships: options.memberships,
      metrics: createNotificationRouteMetrics(options.registry),
      logger: options.logger,
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    return {
      module: NotificationRoutesModule,
      controllers: [NotificationRoutesController],
      providers: [{ provide: NOTIFICATION_ROUTE_SERVICE, useValue: service }],
    };
  }
}
