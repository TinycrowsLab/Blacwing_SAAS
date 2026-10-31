import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { type ZodError, z } from 'zod';

import {
  createNotificationRouteSchema,
  type NotificationRouteEvent,
  type NotificationRouteRecipientSpec,
  type NotificationRouteView,
  type NotificationSeverity,
  notificationRouteEventSchema,
  updateNotificationRouteSchema,
} from '@blackwing/contracts';
import { hasPermission, permissionsForRoles } from '@blackwing/domain';
import { AppError, ForbiddenError, NotFoundError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import {
  createCedarChannelPolicy,
  type ChannelPolicyEngine,
} from '../notification-channels/policy.js';
import { CHANNEL_MANAGE_PERMISSION } from '../notification-channels/service.js';

import type { NotificationRouteMetrics } from './metrics.js';
import type { NotificationRouteStore, RouteChannelLookup } from './ports.js';
import type { ChannelMemberships } from '../notification-channels/ports.js';
import type { NotificationRouteRow } from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/api/notification-routes';
const SPAN_PREFIX = 'notification_route.';

/** The caller: the tenant the guard resolved and the user acting in it. */
export interface NotificationRoutePrincipal {
  readonly tenantId: string;
  readonly actorId: string;
}

export interface NotificationRouteServiceDeps {
  readonly store: NotificationRouteStore;
  readonly channels: RouteChannelLookup;
  readonly memberships: ChannelMemberships;
  readonly metrics: NotificationRouteMetrics;
  readonly logger: Pick<Logger, 'info'>;
  readonly policy?: ChannelPolicyEngine;
  readonly tracer?: Tracer;
}

const uuidSchema = z.uuid();

/** A refused rule with a fixed, non-echoing detail. */
function invalidRoute(detail: string): AppError {
  return new AppError('NOTIFICATION_ROUTE_INVALID', 'invalid notification routing rule', {
    detail,
  });
}

/** Field paths only: issue messages can echo submitted values. */
function invalidFields(error: ZodError): AppError {
  const fields = error.issues.map((issue) => issue.path.map(String).join('.') || '(body)');
  return invalidRoute(`Invalid fields: ${[...new Set(fields)].join(', ')}.`);
}

/** The public view of a stored rule. It names a channel by id and carries no credential. */
export function toNotificationRouteView(row: NotificationRouteRow): NotificationRouteView {
  return {
    id: row.id,
    event: notificationRouteEventSchema.parse(row.event),
    assetId: row.assetId,
    severityMin: row.severityMin,
    channelId: row.channelId,
    recipientSpec: row.recipientSpec,
    enabled: row.enabled,
    priority: row.priority,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Routing rules (NOTIFY-011): which events of the tenant go to which channel, optionally narrowed by asset,
 * severity and recipients. Every call is authorised first with the channel-management grant (RBAC, then Cedar on
 * the tenant). A rule may name only an active channel of its own tenant, so a change cannot route to a channel that
 * cannot deliver. Each write and its audit event commit together.
 */
export class NotificationRouteService {
  private readonly tracer: Tracer;
  private readonly policy: ChannelPolicyEngine;

  constructor(private readonly deps: NotificationRouteServiceDeps) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
    this.policy = deps.policy ?? createCedarChannelPolicy();
  }

  async list(principal: NotificationRoutePrincipal): Promise<readonly NotificationRouteView[]> {
    return this.inSpan('list', async () => {
      await this.authorise(principal);
      return (await this.deps.store.list(principal.tenantId)).map((row) =>
        toNotificationRouteView(row),
      );
    });
  }

  async get(
    principal: NotificationRoutePrincipal,
    routeId: string,
  ): Promise<NotificationRouteView> {
    return this.inSpan('get', async () => {
      await this.authorise(principal);
      return toNotificationRouteView(await this.liveRoute(principal.tenantId, routeId));
    });
  }

  /** Authorise, validate, check the channel is active in this tenant, then commit the rule and its audit event. */
  async create(
    principal: NotificationRoutePrincipal,
    body: unknown,
  ): Promise<NotificationRouteView> {
    return this.inSpan('create', async () => {
      await this.authorise(principal);
      const parsed = createNotificationRouteSchema.safeParse(body);
      if (!parsed.success) throw invalidFields(parsed.error);
      const input = parsed.data;
      await this.assertChannelUsable(principal.tenantId, input.channelId);
      const row = await this.deps.store.create(principal.tenantId, {
        id: newId(),
        event: input.event,
        assetId: input.assetId ?? null,
        severityMin: input.severityMin,
        channelId: input.channelId,
        recipientSpec: input.recipientSpec,
        enabled: input.enabled,
        priority: input.priority,
        createdBy: principal.actorId,
      });
      this.record(principal.tenantId, row, 'created');
      return toNotificationRouteView(row);
    });
  }

  /**
   * Changes a rule. Only the fields sent change. A channel change re-checks the channel is active. A body that
   * changes nothing is a no-op: nothing is written and nothing is audited.
   */
  async update(
    principal: NotificationRoutePrincipal,
    routeId: string,
    body: unknown,
  ): Promise<NotificationRouteView> {
    return this.inSpan('update', async () => {
      await this.authorise(principal);
      const parsed = updateNotificationRouteSchema.safeParse(body);
      if (!parsed.success) throw invalidFields(parsed.error);
      const patch = parsed.data;
      await this.liveRoute(principal.tenantId, routeId);
      if (patch.channelId !== undefined) {
        await this.assertChannelUsable(principal.tenantId, patch.channelId);
      }
      const result = await this.deps.store.update(principal.tenantId, routeId, (locked) => {
        const changedFields: string[] = [];
        const write: {
          event?: NotificationRouteEvent;
          assetId?: string | null;
          severityMin?: NotificationSeverity;
          channelId?: string;
          recipientSpec?: NotificationRouteRecipientSpec;
          enabled?: boolean;
          priority?: number;
        } = {};
        if (patch.event !== undefined && patch.event !== locked.event) {
          changedFields.push('event');
          write.event = patch.event;
        }
        if (patch.assetId !== undefined && patch.assetId !== locked.assetId) {
          changedFields.push('assetId');
          write.assetId = patch.assetId;
        }
        if (patch.severityMin !== undefined && patch.severityMin !== locked.severityMin) {
          changedFields.push('severityMin');
          write.severityMin = patch.severityMin;
        }
        if (patch.channelId !== undefined && patch.channelId !== locked.channelId) {
          changedFields.push('channelId');
          write.channelId = patch.channelId;
        }
        if (
          patch.recipientSpec !== undefined &&
          JSON.stringify(patch.recipientSpec) !== JSON.stringify(locked.recipientSpec)
        ) {
          changedFields.push('recipientSpec');
          write.recipientSpec = patch.recipientSpec;
        }
        if (patch.enabled !== undefined && patch.enabled !== locked.enabled) {
          changedFields.push('enabled');
          write.enabled = patch.enabled;
        }
        if (patch.priority !== undefined && patch.priority !== locked.priority) {
          changedFields.push('priority');
          write.priority = patch.priority;
        }
        if (changedFields.length === 0) return undefined;
        return { ...write, changedFields, op: 'updated', actorId: principal.actorId };
      });
      if (result === undefined) throw new NotFoundError('notification routing rule not found');
      if (result.changed) this.record(principal.tenantId, result.record, 'updated');
      return toNotificationRouteView(result.record);
    });
  }

  /** Deletes a rule and its audit event together. Deleting a missing rule is a not-found. */
  async remove(
    principal: NotificationRoutePrincipal,
    routeId: string,
  ): Promise<NotificationRouteView> {
    return this.inSpan('delete', async () => {
      await this.authorise(principal);
      await this.liveRoute(principal.tenantId, routeId);
      const removed = await this.deps.store.remove(principal.tenantId, routeId, principal.actorId);
      if (removed === undefined) throw new NotFoundError('notification routing rule not found');
      this.record(principal.tenantId, removed, 'deleted');
      return toNotificationRouteView(removed);
    });
  }

  /** The channel must exist in this tenant and be active: a rule never routes to a channel that cannot deliver. */
  private async assertChannelUsable(tenantId: string, channelId: string): Promise<void> {
    const channel = await this.deps.channels.find(tenantId, channelId);
    if (channel === undefined) {
      throw invalidRoute('channelId names no notification channel in this tenant.');
    }
    if (channel.status !== 'active') {
      throw invalidRoute('channelId names a disabled notification channel.');
    }
  }

  /** RBAC first (the grant), then Cedar (the tenant, again, on the resource). Deny by default. */
  private async authorise(principal: NotificationRoutePrincipal): Promise<void> {
    const userId = uuidSchema.safeParse(principal.actorId);
    const roles = userId.success
      ? await this.deps.memberships.rolesOf(principal.tenantId, userId.data)
      : [];
    if (!hasPermission(roles, CHANNEL_MANAGE_PERMISSION)) {
      throw new ForbiddenError('the caller may not manage notification routing rules', {
        detail: `Missing permission ${CHANNEL_MANAGE_PERMISSION} in this tenant.`,
      });
    }
    const decision = this.policy.authorize(
      {
        userId: principal.actorId,
        tenantId: principal.tenantId,
        roles,
        permissions: [...permissionsForRoles(roles)],
      },
      principal.tenantId,
    );
    if (decision.decision !== 'allow') {
      throw new ForbiddenError('the caller may not manage notification routing rules', {
        detail: 'Cedar denied the routing rule operation in this tenant.',
      });
    }
  }

  private async liveRoute(tenantId: string, routeId: string): Promise<NotificationRouteRow> {
    const parsed = uuidSchema.safeParse(routeId);
    const row = parsed.success ? await this.deps.store.find(tenantId, parsed.data) : undefined;
    if (row === undefined) throw new NotFoundError('notification routing rule not found');
    return row;
  }

  /** Metrics and the structured log line: ids and the op only, never a recipient address. */
  private record(tenantId: string, row: NotificationRouteRow, op: string): void {
    this.deps.metrics.changed(op);
    this.deps.logger.info(
      { tenantId, routeId: row.id, channelId: row.channelId, op },
      'notification_route.changed',
    );
  }

  private async inSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(`${SPAN_PREFIX}${name}`, async (span: Span) => {
      try {
        return await fn();
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
