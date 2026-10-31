import { z } from 'zod';

import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_RECIPIENTS_MAX,
  notificationEventTypeSchema,
  notificationSeveritySchema,
} from './notify.js';
import { uuidV7Schema } from './primitives.js';

/**
 * Notification routing rules (NOTIFY-011, CONTEXT_PACK §3.2, §8.6, §8.8). A rule says which events of one
 * tenant go to which channel and recipients, optionally narrowed to one asset and to a minimum severity. The
 * `notify()` core resolves the rules that match a request (`@blackwing/notify`, `resolveRoutes`). A rule names a
 * channel by id and never carries a credential; a rule that names no recipients uses the channel's own audience.
 */

/** The event a rule matches when it applies to every event. */
export const NOTIFICATION_ROUTE_EVENT_ANY = '*';

/** Every event a rule may name: one notice event, or the wildcard. */
export const notificationRouteEventSchema = z.union([
  z.literal(NOTIFICATION_ROUTE_EVENT_ANY),
  notificationEventTypeSchema,
]);
export type NotificationRouteEvent = z.infer<typeof notificationRouteEventSchema>;

/** Rules are ordered by `priority` (higher first) inside one specificity tier. */
export const NOTIFICATION_ROUTE_PRIORITY_MIN = -1000;
export const NOTIFICATION_ROUTE_PRIORITY_MAX = 1000;

/** Longest on-call group name, in characters. Groups are the tenant's on-call rosters, by name. */
export const NOTIFICATION_ROUTE_ON_CALL_GROUP_MAX = 120;

/** RFC 5321 limit on an e-mail address, in characters. */
const EMAIL_MAX = 254;

/**
 * Who a rule narrows an e-mail delivery to. Both fields are optional and combine as a union; the union is then
 * intersected with the channel's own addresses, so a rule never widens a channel's audience. An empty spec, or
 * one whose group has no members, uses the channel's full audience.
 */
export const notificationRouteRecipientSpecSchema = z.strictObject({
  emails: z.array(z.email().max(EMAIL_MAX)).min(1).max(NOTIFICATION_RECIPIENTS_MAX).optional(),
  onCallGroup: z
    .string()
    .trim()
    .min(1)
    .max(NOTIFICATION_ROUTE_ON_CALL_GROUP_MAX)
    .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u, 'must not contain control characters')
    .optional(),
});
export type NotificationRouteRecipientSpec = z.infer<typeof notificationRouteRecipientSpecSchema>;

/** Body of `POST /v1/notification-routes`. `assetId: null` (or absent) matches every asset. */
export const createNotificationRouteSchema = z.strictObject({
  event: notificationRouteEventSchema,
  assetId: uuidV7Schema.nullable().optional(),
  severityMin: notificationSeveritySchema.default('info'),
  channelId: uuidV7Schema,
  recipientSpec: notificationRouteRecipientSpecSchema.default({}),
  enabled: z.boolean().default(true),
  priority: z
    .number()
    .int()
    .min(NOTIFICATION_ROUTE_PRIORITY_MIN)
    .max(NOTIFICATION_ROUTE_PRIORITY_MAX)
    .default(0),
});
export type CreateNotificationRouteBody = z.input<typeof createNotificationRouteSchema>;

/**
 * Body of `PATCH /v1/notification-routes/{id}`: every field is optional and no default applies, so an absent
 * field keeps its stored value. An empty body is refused.
 */
export const updateNotificationRouteSchema = z
  .strictObject({
    event: notificationRouteEventSchema.optional(),
    assetId: uuidV7Schema.nullable().optional(),
    severityMin: notificationSeveritySchema.optional(),
    channelId: uuidV7Schema.optional(),
    recipientSpec: notificationRouteRecipientSpecSchema.optional(),
    enabled: z.boolean().optional(),
    priority: z
      .number()
      .int()
      .min(NOTIFICATION_ROUTE_PRIORITY_MIN)
      .max(NOTIFICATION_ROUTE_PRIORITY_MAX)
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'must change at least one field',
  });
export type UpdateNotificationRouteBody = z.input<typeof updateNotificationRouteSchema>;

/** The public view of a stored rule. */
export const notificationRouteViewSchema = z
  .object({
    id: z.uuid(),
    event: notificationRouteEventSchema,
    assetId: z.uuid().nullable(),
    severityMin: notificationSeveritySchema,
    channelId: z.uuid(),
    recipientSpec: notificationRouteRecipientSpecSchema,
    enabled: z.boolean(),
    priority: z.number().int(),
    createdBy: z.uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type NotificationRouteView = z.infer<typeof notificationRouteViewSchema>;

/** Every event name a rule may match, plus the wildcard, for the database CHECK and the OpenAPI enum. */
export const NOTIFICATION_ROUTE_EVENTS = [
  NOTIFICATION_ROUTE_EVENT_ANY,
  ...NOTIFICATION_EVENT_TYPES,
] as const;
