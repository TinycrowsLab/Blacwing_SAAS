import {
  emailChannelConfigSchema,
  isCriticalNotificationEvent,
  type NotificationChannelKind,
  type NotificationRequest,
  type NotifySendPayload,
  type NotificationRouteRecipientSpec,
} from '@blackwing/contracts';

import { renderNotification } from './render.js';
import { matchRoutes, type RouteRule, ruleRecipients } from './routing.js';

import type { ChannelRegistry } from './channel.js';

/**
 * Routing and planning (NOTIFY-002, NOTIFY-011 precursor). Pure: it takes the tenant's channel rows and the
 * registry and returns what to enqueue. The notifier does the I/O (load the rows, write the outbox), so this
 * module is tested without a database.
 *
 * Routing policy (NOTIFY-011): when the tenant has no enabled routing rule, every active channel receives every
 * event (the broadcast default, so no event is silently unrouted before rules exist). Once it has one, only the
 * channels that matching rules name receive the event (`routing.ts`). A critical event that no channel delivers
 * falls back to the tenant's organisation admins by e-mail, whichever mode routed it.
 */

/** A channel row as the planner reads it: the tenant's own, active or not. */
export interface RoutableChannel {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: NotificationChannelKind;
  readonly config: Record<string, unknown>;
  readonly status: 'active' | 'disabled';
}

/** Why a channel received nothing. Every skip is reported, never dropped silently. */
export type SkipReason =
  | 'wrong_tenant'
  | 'disabled'
  | 'no_implementation'
  | 'invalid_config'
  | 'no_matching_recipient'
  | 'unknown_channel';

export interface SkippedChannel {
  readonly channelId: string;
  readonly reason: SkipReason;
}

/** One `notify.send` row to write. `channelId` is `null` for the critical admin fallback. */
export interface PlannedDelivery {
  readonly channelId: string | null;
  readonly kind: NotificationChannelKind;
  /** The outbox dedupe key: stable for one request and one target, so a repeated request enqueues nothing new. */
  readonly dedupeKey: string;
  readonly payload: NotifySendPayload;
}

export interface DeliveryPlan {
  readonly deliveries: readonly PlannedDelivery[];
  readonly skipped: readonly SkippedChannel[];
  /** True when the deliveries are the critical fallback, not a configured channel. */
  readonly fallback: boolean;
  /** True when nothing will be delivered: the request is recorded as unrouted. */
  readonly unrouted: boolean;
  /** Routing rules that matched the request (0 in broadcast mode). */
  readonly matchedRules: number;
}

export interface PlanInput {
  readonly request: NotificationRequest;
  readonly notificationId: string;
  readonly channels: readonly RoutableChannel[];
  readonly registry: ChannelRegistry;
  readonly consoleUrl: string;
  /** E-mail addresses of the tenant's organisation admins, for the critical fallback. */
  readonly adminRecipients: readonly string[];
  /** The tenant's routing rules (all of them; the matcher keeps the enabled ones). Absent: none. */
  readonly routes?: readonly RouteRule[];
  /** On-call group name to the e-mail addresses of its members, for rules that name a group. */
  readonly groups?: Readonly<Record<string, readonly string[]>>;
}

/** A channel one request is routed to, with the recipient narrowing of the rule that routed it (if any). */
interface Target {
  readonly channel: RoutableChannel;
  readonly spec: NotificationRouteRecipientSpec | undefined;
}

/** The outbox dedupe key of one delivery. The request's own key, or the notification id when it has none. */
export function deliveryDedupeKey(
  request: Pick<NotificationRequest, 'dedupeKey'>,
  notificationId: string,
  target: string,
): string {
  return `notify:${request.dedupeKey ?? notificationId}:${target}`;
}

/** Plans the deliveries for one request. Deterministic for the same inputs. */
export function planDeliveries(input: PlanInput): DeliveryPlan {
  const { request, notificationId, registry, consoleUrl } = input;
  const deliveries: PlannedDelivery[] = [];
  const skipped: SkippedChannel[] = [];
  const wanted = request.recipients?.map((address) => address.toLowerCase());
  const { targets, matchedRules } = routeTargets(input, skipped);

  for (const { channel, spec } of targets) {
    if (channel.tenantId !== request.tenantId) {
      skipped.push({ channelId: channel.id, reason: 'wrong_tenant' });
      continue;
    }
    if (channel.status !== 'active') {
      skipped.push({ channelId: channel.id, reason: 'disabled' });
      continue;
    }
    const implementation = registry.get(channel.kind);
    if (implementation === undefined) {
      skipped.push({ channelId: channel.id, reason: 'no_implementation' });
      continue;
    }
    let recipients: string[] | undefined;
    if (channel.kind === 'email') {
      const parsed = emailChannelConfigSchema.safeParse(channel.config);
      if (!parsed.success) {
        skipped.push({ channelId: channel.id, reason: 'invalid_config' });
        continue;
      }
      // The channel's own audience, narrowed by the request and then by the rule. Neither ever widens it.
      const routed = spec === undefined ? undefined : ruleRecipients(spec, input.groups);
      recipients = parsed.data.addresses.filter(
        (address) =>
          (wanted === undefined || wanted.includes(address.toLowerCase())) &&
          (routed === undefined || routed.includes(address.toLowerCase())),
      );
      if (recipients.length === 0) {
        skipped.push({ channelId: channel.id, reason: 'no_matching_recipient' });
        continue;
      }
    } else if (!configValid(implementation, channel.config)) {
      skipped.push({ channelId: channel.id, reason: 'invalid_config' });
      continue;
    }
    deliveries.push(
      buildDelivery({
        request,
        notificationId,
        consoleUrl,
        channelId: channel.id,
        kind: channel.kind,
        supportsActions: implementation.supportsActions,
        recipients,
      }),
    );
  }

  if (deliveries.length === 0 && isCriticalNotificationEvent(request.event)) {
    const email = registry.get('email');
    if (email !== undefined && input.adminRecipients.length > 0) {
      deliveries.push(
        buildDelivery({
          request,
          notificationId,
          consoleUrl,
          channelId: null,
          kind: 'email',
          supportsActions: email.supportsActions,
          recipients: [...input.adminRecipients],
        }),
      );
      return { deliveries, skipped, fallback: true, unrouted: false, matchedRules };
    }
  }

  return { deliveries, skipped, fallback: false, unrouted: deliveries.length === 0, matchedRules };
}

/**
 * The channels a request is routed to. Broadcast when the tenant has no enabled rule; otherwise the channels of the
 * matching rules, in rule order, each channel once (a channel named by two rules gets one message). A rule naming
 * an unknown or disabled channel is skipped and reported, and the other rules still apply.
 */
function routeTargets(
  input: PlanInput,
  skipped: SkippedChannel[],
): { readonly targets: readonly Target[]; readonly matchedRules: number } {
  const routes = input.routes ?? [];
  if (!routes.some((rule) => rule.enabled)) {
    return {
      targets: input.channels.map((channel) => ({ channel, spec: undefined })),
      matchedRules: 0,
    };
  }
  const matches = matchRoutes(
    {
      event: input.request.event,
      assetId: input.request.assetId,
      severity: input.request.severity,
    },
    routes,
  );
  const byId = new Map(input.channels.map((channel) => [channel.id, channel] as const));
  const seen = new Set<string>();
  const targets: Target[] = [];
  for (const { rule } of matches) {
    if (seen.has(rule.channelId)) continue;
    seen.add(rule.channelId);
    const channel = byId.get(rule.channelId);
    if (channel === undefined) {
      skipped.push({ channelId: rule.channelId, reason: 'unknown_channel' });
      continue;
    }
    if (channel.status !== 'active') {
      skipped.push({ channelId: channel.id, reason: 'disabled' });
      continue;
    }
    targets.push({ channel, spec: rule.recipientSpec });
  }
  return { targets, matchedRules: matches.length };
}

/** True when the implementation accepts the stored config. A throwing validator counts as invalid. */
function configValid(
  implementation: { validate(config: unknown): unknown },
  config: Record<string, unknown>,
): boolean {
  try {
    implementation.validate(config);
    return true;
  } catch {
    return false;
  }
}

interface BuildInput {
  readonly request: NotificationRequest;
  readonly notificationId: string;
  readonly consoleUrl: string;
  readonly channelId: string | null;
  readonly kind: NotificationChannelKind;
  readonly supportsActions: boolean;
  /** E-mail deliveries only; `undefined` for every other kind. */
  readonly recipients: string[] | undefined;
}

function buildDelivery(input: BuildInput): PlannedDelivery {
  const { request, notificationId, channelId, kind, recipients } = input;
  const rendered = renderNotification(request, {
    consoleUrl: input.consoleUrl,
    supportsActions: input.supportsActions,
  });
  const target = channelId ?? 'admins';
  return {
    channelId,
    kind,
    dedupeKey: deliveryDedupeKey(request, notificationId, target),
    payload: {
      notificationId,
      event: request.event,
      severity: request.severity,
      channel: { id: channelId, kind },
      ...(recipients === undefined ? {} : { recipients }),
      message: {
        subject: rendered.subject,
        text: rendered.text,
        actions: rendered.actions.map((action) => ({ ...action })),
      },
    },
  };
}
