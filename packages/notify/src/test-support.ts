import type { NotificationChannel, NotificationSendResult, RenderedMessage } from './channel.js';
import type { RoutableChannel } from './plan.js';
import type { NotificationChannelKind } from '@blackwing/contracts';

/** A channel that records what it was asked to send and never touches a provider. */
export function stubChannel(
  kind: NotificationChannelKind,
  supportsActions = true,
): NotificationChannel & { readonly sent: RenderedMessage[] } {
  const sent: RenderedMessage[] = [];
  return {
    kind,
    supportsActions,
    sent,
    validate(config) {
      if (typeof config !== 'object' || config === null || 'bad' in config) {
        throw new Error('invalid stub config');
      }
      return { ...config };
    },
    send(message): Promise<NotificationSendResult> {
      sent.push(message);
      return Promise.resolve({ ok: true });
    },
  };
}

export const TENANT = '018f7a52-7c1e-7d3a-8b9c-0123456789ab';
export const OTHER_TENANT = '018f7a52-7c1e-7d3a-8b9c-0123456789af';
export const NOTIFICATION = '018f7a52-7c1e-7d3a-8b9c-0123456789ac';
export const CHANNEL_A = '018f7a52-7c1e-7d3a-8b9c-0123456789b0';
export const CHANNEL_B = '018f7a52-7c1e-7d3a-8b9c-0123456789b1';
export const RUN = '018f7a52-7c1e-7d3a-8b9c-0123456789ad';

export function channel(
  overrides: Partial<RoutableChannel> & Pick<RoutableChannel, 'id' | 'kind'>,
): RoutableChannel {
  return { tenantId: TENANT, config: {}, status: 'active', ...overrides };
}
