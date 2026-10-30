import {
  parseNotificationChannelConfig,
  type NotificationAction,
  type NotificationChannelKind,
} from '@blackwing/contracts';

/**
 * The provider interface every delivery channel implements (NOTIFY-002, CONTEXT_PACK §3.1). The core never
 * speaks to a provider: it resolves targets and enqueues a `notify.send` row, and the delivery worker (NOTIFY-012)
 * calls {@link NotificationChannel.send} for each row, so a slow or failing provider never blocks a caller.
 * Concrete channels (email, Slack, Teams, webhook, PagerDuty, Opsgenie) arrive in NOTIFY-004..009.
 */

/** A message after rendering for one channel: the text every channel can show, plus structured action links. */
export interface RenderedMessage {
  readonly subject: string;
  readonly text: string;
  /**
   * The action links for a channel that renders buttons (`supportsActions`). Empty otherwise: those channels
   * get the same links as text lines inside {@link RenderedMessage.text}, so no action is ever dropped.
   */
  readonly actions: readonly NotificationAction[];
}

/** What one provider call reports. `retriable: false` with `ok: false` is a permanent refusal. */
export interface NotificationSendResult {
  readonly ok: boolean;
  /** The provider's own id for the message, when it returns one (audit and support use it). */
  readonly providerMessageId?: string;
  /** Whether a retry can succeed (timeouts, 429, 5xx). Absent means the worker decides by its own policy. */
  readonly retriable?: boolean;
  /** A short, credential-free reason for a failure. */
  readonly detail?: string;
}

/** One delivery implementation, keyed by the channel `kind` it serves. */
export interface NotificationChannel {
  readonly kind: NotificationChannelKind;
  /** True when the provider renders action links as buttons; false when they are sent as text. */
  readonly supportsActions: boolean;
  /**
   * Checks a stored channel config against this kind and returns its normalised form. Throws (a Zod error)
   * on an unknown or malformed key, so a config that cannot deliver is refused rather than sent half-formed.
   */
  validate(config: unknown): Record<string, unknown>;
  /**
   * Delivers one message. `secret` is the resolved credential (a webhook URL, an API key) or `undefined` for
   * kinds that carry none. Must be safe to repeat: the worker delivers at least once.
   */
  send(
    message: RenderedMessage,
    config: Record<string, unknown>,
    secret: string | undefined,
  ): Promise<NotificationSendResult>;
}

/** Maps a channel kind to its implementation. Only registered kinds can be enqueued. */
export interface ChannelRegistry {
  get(kind: NotificationChannelKind): NotificationChannel | undefined;
  readonly kinds: readonly NotificationChannelKind[];
}

/**
 * Builds the registry. Two implementations for one kind is a wiring error, so it throws at start-up rather than
 * letting one silently shadow the other.
 */
export function createChannelRegistry(channels: readonly NotificationChannel[]): ChannelRegistry {
  const byKind = new Map<NotificationChannelKind, NotificationChannel>();
  for (const channel of channels) {
    if (byKind.has(channel.kind)) {
      throw new Error(`notification channel kind "${channel.kind}" is registered twice`);
    }
    byKind.set(channel.kind, channel);
  }
  return {
    get: (kind) => byKind.get(kind),
    kinds: [...byKind.keys()],
  };
}

/** The default `validate`: the strict per-kind config schema of `@blackwing/contracts`. */
export function validateWithKindSchema(
  kind: NotificationChannelKind,
  config: unknown,
): Record<string, unknown> {
  return parseNotificationChannelConfig(kind, config);
}
