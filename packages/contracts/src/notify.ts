import { z } from 'zod';

import { notificationChannelKindSchema } from './notifications.js';
import { uuidV7Schema } from './primitives.js';

/**
 * The notification request and the delivery intent it becomes (NOTIFY-002, CONTEXT_PACK §3.1, §7, §8.6, §8.7).
 * A caller describes WHAT happened (an event, a severity, a template body and optional action links); the
 * `notify()` core in `@blackwing/notify` decides WHERE it goes and writes one `notify.send` outbox row per
 * target channel. These schemas are the boundary: a request that does not parse is refused before any row is
 * written, and a body carries only identifiers and short values, never a credential.
 */

/** Every event a caller may notify about. Additive only: a new event is a new entry, never a rename. */
export const NOTIFICATION_EVENT_TYPES = [
  'gate1.requested',
  'gate2.exception',
  'gate3.release_requested',
  'run.completed',
  'run.failed',
  'kill.fired',
  'soc.test_window',
  'soc.window_opened',
  'budget.cap',
  'finding.released',
  'system.alert',
] as const;
export const notificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);
export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>;

/** How urgent a notice is. Ordered from least to most urgent. */
export const NOTIFICATION_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export const notificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

/**
 * Events that must reach a human even when no channel routes them (kill switch, Gate 2 exception, SOC test window). When no
 * channel delivers one of these, the core falls back to the tenant's organisation admins by e-mail.
 */
export const CRITICAL_NOTIFICATION_EVENTS = [
  'kill.fired',
  'gate2.exception',
  'soc.test_window',
] as const satisfies readonly NotificationEventType[];

/** Events whose notify requests are audited (`notification.requested`), in addition to the unrouted audit. */
export const AUDITED_NOTIFICATION_EVENT_PREFIXES = ['gate', 'kill.'] as const;

/** Most action links one notice carries. Actions are never truncated, so the count is bounded. */
export const NOTIFICATION_ACTIONS_MAX = 5;

/** Most body entries (template fields) one request carries. */
export const NOTIFICATION_BODY_KEYS_MAX = 50;

/** Longest string body value, in characters. Longer values are cut by the renderer, not refused. */
export const NOTIFICATION_BODY_VALUE_MAX = 500;

/** Longest subject, in characters. */
export const NOTIFICATION_SUBJECT_MAX = 200;

/** Longest caller idempotency key. Leaves room in the outbox key for the channel id suffix. */
export const NOTIFICATION_DEDUPE_KEY_MAX = 200;

/** Most explicit recipient addresses a request may narrow a delivery to. */
export const NOTIFICATION_RECIPIENTS_MAX = 20;

/** RFC 5321 limit on an e-mail address, in characters. */
const EMAIL_MAX = 254;

/** Longest action label, in characters. */
const ACTION_LABEL_MAX = 60;

/** Longest action href, in characters. */
const ACTION_HREF_MAX = 2048;

/** No ASCII control characters (or DEL), and no Unicode line or paragraph separators. */
const NO_CONTROL = /^[^\p{Cc}\p{Zl}\p{Zp}]*$/u;

/** An https URL with no userinfo, or an app-relative path that cannot turn into another origin. */
export function isSafeActionHref(value: string): boolean {
  if (value.startsWith('/')) {
    return !value.startsWith('//') && !value.includes('\\') && NO_CONTROL.test(value);
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== ''
    );
  } catch {
    return false;
  }
}

/** A link a recipient can follow from the notice (approve, open the run). Never a credential. */
export const notificationActionSchema = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1)
    .max(ACTION_LABEL_MAX)
    .regex(NO_CONTROL, 'must not contain control characters'),
  href: z
    .string()
    .max(ACTION_HREF_MAX)
    .refine(isSafeActionHref, 'must be an https URL with no credentials, or an app-relative path'),
});
export type NotificationAction = z.infer<typeof notificationActionSchema>;

/** A template field value. Strings are the common case; numbers and booleans carry counts and flags. */
export const notificationBodyValueSchema = z.union([
  z
    .string()
    .max(NOTIFICATION_BODY_VALUE_MAX)
    .regex(NO_CONTROL, 'must not contain control characters'),
  z.number(),
  z.boolean(),
  z.null(),
]);

/** Longest template field name, in characters. */
const BODY_KEY_MAX = 64;

/** The template data of a notice: a flat map of short, named fields. */
export const notificationBodySchema = z
  .record(
    z
      .string()
      .min(1)
      .max(BODY_KEY_MAX)
      .regex(/^[a-z][a-zA-Z0-9_]*$/, 'must be a lower- or camelCase field name'),
    notificationBodyValueSchema,
  )
  .refine((body) => Object.keys(body).length <= NOTIFICATION_BODY_KEYS_MAX, {
    message: `must have at most ${NOTIFICATION_BODY_KEYS_MAX} fields`,
  });
export type NotificationBody = z.infer<typeof notificationBodySchema>;

/**
 * A caller's notification. `tenantId` is the tenant the notice belongs to: the core opens that tenant's
 * context, so a request can never reach another tenant's channels (§8.6). `recipients`, when given, only
 * narrows e-mail delivery to addresses the channel already names; it never widens it.
 */
export const notificationRequestSchema = z.strictObject({
  tenantId: uuidV7Schema,
  event: notificationEventTypeSchema,
  severity: notificationSeveritySchema,
  subject: z
    .string()
    .trim()
    .min(1)
    .max(NOTIFICATION_SUBJECT_MAX)
    .regex(NO_CONTROL, 'must not contain control characters'),
  body: notificationBodySchema.default({}),
  actions: z.array(notificationActionSchema).max(NOTIFICATION_ACTIONS_MAX).optional(),
  dedupeKey: z
    .string()
    .regex(/^[\x21-\x7e]{1,200}$/, 'must be 1-200 printable ASCII characters without spaces')
    .optional(),
  recipients: z.array(z.email().max(EMAIL_MAX)).min(1).max(NOTIFICATION_RECIPIENTS_MAX).optional(),
  runId: uuidV7Schema.optional(),
  assetId: uuidV7Schema.optional(),
});
export type NotificationRequest = z.infer<typeof notificationRequestSchema>;

/**
 * The payload of one `notify.send` outbox row: a single delivery to one channel (or, when `channel.id` is
 * `null`, the critical fallback to the tenant's admins by e-mail). It names the channel by id and never
 * carries its credential; the delivery worker (NOTIFY-012) resolves that through the secrets service.
 */
export const notifySendPayloadSchema = z.strictObject({
  notificationId: uuidV7Schema,
  event: notificationEventTypeSchema,
  severity: notificationSeveritySchema,
  channel: z.strictObject({
    id: uuidV7Schema.nullable(),
    kind: notificationChannelKindSchema,
  }),
  /** E-mail deliveries only: the addresses this delivery goes to. */
  recipients: z.array(z.email().max(EMAIL_MAX)).min(1).max(NOTIFICATION_RECIPIENTS_MAX).optional(),
  message: z.strictObject({
    subject: z.string().min(1).max(NOTIFICATION_SUBJECT_MAX),
    text: z.string().min(1),
    actions: z.array(notificationActionSchema).max(NOTIFICATION_ACTIONS_MAX),
  }),
});
export type NotifySendPayload = z.infer<typeof notifySendPayloadSchema>;

/** True when `event` is a critical event (kill switch, Gate 2 exception). */
export function isCriticalNotificationEvent(event: NotificationEventType): boolean {
  return (CRITICAL_NOTIFICATION_EVENTS as readonly string[]).includes(event);
}

/** True when a notify request for `event` is audited (gate and kill events). */
export function isAuditedNotificationEvent(event: NotificationEventType): boolean {
  return AUDITED_NOTIFICATION_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix));
}
