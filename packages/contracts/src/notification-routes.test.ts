import { describe, expect, it } from 'vitest';

import {
  createNotificationRouteSchema,
  NOTIFICATION_ROUTE_EVENTS,
  notificationRouteRecipientSpecSchema,
  updateNotificationRouteSchema,
} from './notification-routes.js';

const CHANNEL = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8c01';
const ASSET = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8e01';

describe('createNotificationRouteSchema', () => {
  it('applies the defaults: info severity, no recipients narrowing, enabled, priority 0, every asset', () => {
    const parsed = createNotificationRouteSchema.parse({ event: '*', channelId: CHANNEL });
    expect(parsed).toEqual({
      event: '*',
      channelId: CHANNEL,
      severityMin: 'info',
      recipientSpec: {},
      enabled: true,
      priority: 0,
    });
  });

  it('accepts an asset, a minimum severity and an on-call group', () => {
    const parsed = createNotificationRouteSchema.parse({
      event: 'kill.fired',
      assetId: ASSET,
      severityMin: 'critical',
      channelId: CHANNEL,
      recipientSpec: { onCallGroup: 'soc-primary' },
      priority: 10,
    });
    expect(parsed.assetId).toBe(ASSET);
    expect(parsed.recipientSpec).toEqual({ onCallGroup: 'soc-primary' });
  });

  it('refuses an event outside the notice event set (and the wildcard is the only extra)', () => {
    expect(NOTIFICATION_ROUTE_EVENTS).toContain('*');
    expect(
      createNotificationRouteSchema.safeParse({ event: 'made.up', channelId: CHANNEL }).success,
    ).toBe(false);
  });

  it('refuses an unknown field, a non-uuid channel and an out-of-range priority', () => {
    expect(
      createNotificationRouteSchema.safeParse({ event: '*', channelId: CHANNEL, webhook: 'x' })
        .success,
    ).toBe(false);
    expect(
      createNotificationRouteSchema.safeParse({ event: '*', channelId: 'not-a-uuid' }).success,
    ).toBe(false);
    expect(
      createNotificationRouteSchema.safeParse({ event: '*', channelId: CHANNEL, priority: 1001 })
        .success,
    ).toBe(false);
    expect(
      createNotificationRouteSchema.safeParse({ event: '*', channelId: CHANNEL, priority: 1.5 })
        .success,
    ).toBe(false);
  });

  it('refuses a recipient address that is not an e-mail', () => {
    const body = { event: '*', channelId: CHANNEL, recipientSpec: { emails: ['not an address'] } };
    expect(createNotificationRouteSchema.safeParse(body).success).toBe(false);
  });
});

describe('updateNotificationRouteSchema', () => {
  it('refuses an empty body, so a patch always changes something', () => {
    expect(updateNotificationRouteSchema.safeParse({}).success).toBe(false);
  });

  it('applies no default, so an absent field is not reset', () => {
    const parsed = updateNotificationRouteSchema.parse({ priority: 3 });
    expect(parsed).toEqual({ priority: 3 });
  });

  it('allows an asset to be cleared back to every asset', () => {
    expect(updateNotificationRouteSchema.parse({ assetId: null })).toEqual({ assetId: null });
  });
});

describe('notificationRouteRecipientSpecSchema', () => {
  it('refuses an empty address list and a control character in the group name', () => {
    expect(notificationRouteRecipientSpecSchema.safeParse({ emails: [] }).success).toBe(false);
    expect(
      notificationRouteRecipientSpecSchema.safeParse({ onCallGroup: 'soc\u0007' }).success,
    ).toBe(false);
    expect(notificationRouteRecipientSpecSchema.safeParse({ onCallGroup: '   ' }).success).toBe(
      false,
    );
  });

  it('refuses a key that is not a recipient field', () => {
    expect(
      notificationRouteRecipientSpecSchema.safeParse({ webhook: 'https://x.example' }).success,
    ).toBe(false);
  });
});
