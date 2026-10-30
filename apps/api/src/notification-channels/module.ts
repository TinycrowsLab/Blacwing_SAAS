import { type DynamicModule, Module } from '@nestjs/common';

import { NotificationChannelsController } from './controller.js';
import { createNotificationChannelMetrics } from './metrics.js';
import { NotificationChannelService, type NotificationChannelServiceDeps } from './service.js';
import { NOTIFICATION_CHANNEL_SERVICE } from './tokens.js';

import type { ChannelReferences } from './ports.js';
import type { Registry } from 'prom-client';

export interface NotificationChannelsModuleOptions extends Pick<
  NotificationChannelServiceDeps,
  'store' | 'memberships' | 'secrets' | 'logger' | 'tracer'
> {
  /** Routing-rule references that block a delete. Absent: no rule references (see `noRoutingRules`). */
  readonly references?: ChannelReferences;
  /** Registry the `bw_notification_channel_changes_total` counter lives on. */
  readonly registry: Registry;
}

/** Until routing rules exist (NOTIFY-011) no rule can reference a channel, so no delete is ever blocked. */
export const noRoutingRules: ChannelReferences = {
  activeRuleIds: () => Promise.resolve([]),
};

/**
 * Mounts `/v1/notification-channels`. The store is the Postgres adapter of @blackwing/db and `secrets` the
 * envelope sealer of @blackwing/secrets in a deployment; tests pass fakes. Mount it through
 * `createApiApp({ imports })` under the global tenant guard, or it answers 401 (fail closed).
 */
@Module({})
export class NotificationChannelsModule {
  static forRoot(options: NotificationChannelsModuleOptions): DynamicModule {
    const service = new NotificationChannelService({
      store: options.store,
      memberships: options.memberships,
      secrets: options.secrets,
      references: options.references ?? noRoutingRules,
      metrics: createNotificationChannelMetrics(options.registry),
      logger: options.logger,
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    return {
      module: NotificationChannelsModule,
      controllers: [NotificationChannelsController],
      providers: [{ provide: NOTIFICATION_CHANNEL_SERVICE, useValue: service }],
    };
  }
}
