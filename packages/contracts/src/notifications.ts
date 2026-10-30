import { z } from 'zod';

/**
 * Notification channels (NOTIFY-001, CONTEXT_PACK §7, §8.6, §8.7). A channel is where Blackwing delivers
 * notices (F13 gates, F33 kill and SOC notices). Its non-secret settings live in `config`; any credential
 * (a Slack or Teams webhook URL, a PagerDuty integration key, an Opsgenie API key, a webhook HMAC key) is
 * stored as a secret and only its `secret_ref` is kept on the channel. These schemas are strict on purpose:
 * a config key that could carry a credential is refused, so a secret-bearing URL cannot sneak into plaintext.
 */

/** Delivery kinds. Email needs no credential of its own; every other kind has one. */
export const NOTIFICATION_CHANNEL_KINDS = [
  'email',
  'slack',
  'teams',
  'webhook',
  'pagerduty',
  'opsgenie',
] as const;
export const notificationChannelKindSchema = z.enum(NOTIFICATION_CHANNEL_KINDS);
export type NotificationChannelKind = z.infer<typeof notificationChannelKindSchema>;

/** Kinds whose delivery needs a credential, which must arrive as `secret` and is stored by reference. */
export const SECRET_BEARING_CHANNEL_KINDS = [
  'slack',
  'teams',
  'webhook',
  'pagerduty',
  'opsgenie',
] as const satisfies readonly NotificationChannelKind[];

/** `active` delivers; `disabled` keeps the record and its secret reference but sends nothing. */
export const NOTIFICATION_CHANNEL_STATUSES = ['active', 'disabled'] as const;
export const notificationChannelStatusSchema = z.enum(NOTIFICATION_CHANNEL_STATUSES);
export type NotificationChannelStatus = z.infer<typeof notificationChannelStatusSchema>;

/** Longest channel name, in characters. */
export const NOTIFICATION_CHANNEL_NAME_MAX = 120;

/** Longest plaintext secret accepted on a channel write (a webhook URL or an API key, never a file). */
export const NOTIFICATION_SECRET_MAX = 2048;

/** Longest URL, in characters, a channel config may name. */
const URL_MAX = 2048;

/** RFC 5321 limit on an email address, in characters. */
const EMAIL_MAX = 254;

/** Most recipients one email channel may name. */
const EMAIL_RECIPIENTS_MAX = 20;

/** Stable machine code for a second channel with the same name in one tenant (`409`). */
export const CHANNEL_NAME_CONFLICT = 'CHANNEL_NAME_CONFLICT';

/**
 * A channel name: NFC-normalised (canonically equal spellings collide on `(tenant_id, name)`), 1 to
 * {@link NOTIFICATION_CHANNEL_NAME_MAX} characters, with no control or line/paragraph separators, and not
 * blank.
 */
export const notificationChannelNameSchema = z
  .string()
  .transform((value) => value.normalize('NFC'))
  .pipe(
    z
      .string()
      .min(1)
      .max(NOTIFICATION_CHANNEL_NAME_MAX)
      .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), {
        message: 'must not contain control characters',
      })
      .refine((value) => value.trim().length > 0, { message: 'must not be blank' }),
  );

/** An https URL with no userinfo, query or fragment: a public address, never a bearer credential. */
export const publicHttpsUrlSchema = z
  .string()
  .max(URL_MAX)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          url.hash === '' &&
          url.hostname !== ''
        );
      } catch {
        return false;
      }
    },
    { message: 'must be an https URL with no credentials, query or fragment' },
  );

/** Email config: where the notice is sent. Each address is validated; an empty list is refused. */
export const emailChannelConfigSchema = z
  .object({
    addresses: z.array(z.email().max(EMAIL_MAX)).min(1).max(EMAIL_RECIPIENTS_MAX),
  })
  .strict();

/** Slack config: the destination channel label only. The incoming webhook URL is the secret. */
export const slackChannelConfigSchema = z
  .object({
    channel: z
      .string()
      .regex(/^#?[a-z0-9._-]{1,80}$/)
      .optional(),
  })
  .strict();

/** Teams config has no non-secret settings; the incoming webhook URL is the secret. */
export const teamsChannelConfigSchema = z.object({}).strict();

/** Generic webhook config: the public endpoint. The HMAC signing key is the secret. */
export const webhookChannelConfigSchema = z
  .object({
    url: publicHttpsUrlSchema,
  })
  .strict();

/** PagerDuty config: the Events API region. The integration (routing) key is the secret. */
export const pagerdutyChannelConfigSchema = z
  .object({
    region: z.enum(['us', 'eu']).default('us'),
  })
  .strict();

/** Opsgenie config: the API region. The API key is the secret. */
export const opsgenieChannelConfigSchema = z
  .object({
    region: z.enum(['us', 'eu']).default('us'),
  })
  .strict();

/** The config schema of each kind; the discriminant is the channel `kind`. */
export const NOTIFICATION_CHANNEL_CONFIG_SCHEMAS = {
  email: emailChannelConfigSchema,
  slack: slackChannelConfigSchema,
  teams: teamsChannelConfigSchema,
  webhook: webhookChannelConfigSchema,
  pagerduty: pagerdutyChannelConfigSchema,
  opsgenie: opsgenieChannelConfigSchema,
} as const satisfies Record<NotificationChannelKind, z.ZodType>;

/**
 * The credential a channel is delivered with, as sent by the caller. It is plaintext on the wire only: the
 * API seals it into the secrets service and keeps the `secret_ref`. A webhook URL must be https.
 */
export const notificationChannelSecretSchema = z.string().min(1).max(NOTIFICATION_SECRET_MAX);

/** A Slack or Teams incoming-webhook URL: an https URL with no userinfo (its token sits in the path). */
const httpsSecretSchema = notificationChannelSecretSchema.refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  },
  { message: 'must be an https URL' },
);

/**
 * Body of `POST /v1/notification-channels`, discriminated by `kind`. A secret-bearing kind must send
 * `secret`; email must not (`.strict()` refuses it). The webhook-URL kinds check the URL form of the secret.
 */
export const createNotificationChannelSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('email'),
      name: notificationChannelNameSchema,
      config: emailChannelConfigSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('slack'),
      name: notificationChannelNameSchema,
      config: slackChannelConfigSchema,
      secret: httpsSecretSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('teams'),
      name: notificationChannelNameSchema,
      config: teamsChannelConfigSchema,
      secret: httpsSecretSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('webhook'),
      name: notificationChannelNameSchema,
      config: webhookChannelConfigSchema,
      secret: notificationChannelSecretSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('pagerduty'),
      name: notificationChannelNameSchema,
      config: pagerdutyChannelConfigSchema,
      secret: notificationChannelSecretSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('opsgenie'),
      name: notificationChannelNameSchema,
      config: opsgenieChannelConfigSchema,
      secret: notificationChannelSecretSchema,
    })
    .strict(),
]);
export type CreateNotificationChannelBody = z.infer<typeof createNotificationChannelSchema>;

/**
 * Body of `PATCH /v1/notification-channels/{id}`. The kind never changes. `config` replaces the whole
 * settings object and is re-validated against the channel's kind by the service. `secret` rotates the
 * credential to a new version; the old version stays resolvable for its grace period.
 */
export const updateNotificationChannelSchema = z
  .object({
    name: notificationChannelNameSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    secret: notificationChannelSecretSchema.optional(),
    status: notificationChannelStatusSchema.optional(),
  })
  .strict();
export type UpdateNotificationChannelBody = z.infer<typeof updateNotificationChannelSchema>;

/** The public view of a channel. It never carries secret material: only the opaque `secretRef`, when one exists. */
export const notificationChannelViewSchema = z
  .object({
    id: z.uuid(),
    kind: notificationChannelKindSchema,
    name: z.string(),
    status: notificationChannelStatusSchema,
    config: z.record(z.string(), z.unknown()),
    secretRef: z.string().nullable(),
    createdBy: z.uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type NotificationChannelView = z.infer<typeof notificationChannelViewSchema>;

/** Query of `DELETE /v1/notification-channels/{id}`: `force` disables a channel that rules still reference. */
export const deleteNotificationChannelQuerySchema = z
  .object({
    force: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

/** Parses the config of a channel of `kind`, strictly, so a stored row is re-checked on every change. */
export function parseNotificationChannelConfig(
  kind: NotificationChannelKind,
  config: unknown,
): Record<string, unknown> {
  return NOTIFICATION_CHANNEL_CONFIG_SCHEMAS[kind].parse(config);
}

/** True when a kind needs a credential (`secret`) to deliver. */
export function channelKindNeedsSecret(kind: NotificationChannelKind): boolean {
  return (SECRET_BEARING_CHANNEL_KINDS as readonly string[]).includes(kind);
}
