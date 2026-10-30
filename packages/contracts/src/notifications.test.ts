import { describe, expect, it } from 'vitest';

import {
  channelKindNeedsSecret,
  createNotificationChannelSchema,
  deleteNotificationChannelQuerySchema,
  NOTIFICATION_CHANNEL_KINDS,
  notificationChannelNameSchema,
  notificationChannelViewSchema,
  parseNotificationChannelConfig,
  publicHttpsUrlSchema,
  updateNotificationChannelSchema,
} from './notifications.js';

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXXXXXX';
const USER_ID = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a77';

describe('notification channel contracts (NOTIFY-001)', () => {
  it('lists the six delivery kinds and marks only the credential-bearing ones', () => {
    expect([...NOTIFICATION_CHANNEL_KINDS]).toEqual([
      'email',
      'slack',
      'teams',
      'webhook',
      'pagerduty',
      'opsgenie',
    ]);
    expect(channelKindNeedsSecret('email')).toBe(false);
    for (const kind of NOTIFICATION_CHANNEL_KINDS.filter((k) => k !== 'email')) {
      expect(channelKindNeedsSecret(kind), kind).toBe(true);
    }
  });

  it('accepts a Slack channel with its webhook URL as the secret', () => {
    const parsed = createNotificationChannelSchema.parse({
      kind: 'slack',
      name: 'Gate alerts',
      config: { channel: 'appsec-alerts' },
      secret: SLACK_URL,
    });
    expect(parsed).toMatchObject({ kind: 'slack', config: { channel: 'appsec-alerts' } });
  });

  it('refuses a secret-bearing kind without its secret, and an email channel that carries one', () => {
    expect(
      createNotificationChannelSchema.safeParse({
        kind: 'slack',
        name: 'x',
        config: {},
      }).success,
    ).toBe(false);
    expect(
      createNotificationChannelSchema.safeParse({
        kind: 'email',
        name: 'x',
        config: { addresses: ['soc@example.test'] },
        secret: 'nope',
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown kind and a config key that could carry a credential', () => {
    expect(
      createNotificationChannelSchema.safeParse({ kind: 'sms', name: 'x', config: {} }).success,
    ).toBe(false);
    expect(
      createNotificationChannelSchema.safeParse({
        kind: 'slack',
        name: 'x',
        config: { webhookUrl: SLACK_URL },
        secret: SLACK_URL,
      }).success,
    ).toBe(false);
    expect(
      createNotificationChannelSchema.safeParse({
        kind: 'pagerduty',
        name: 'x',
        config: { routingKey: 'abc' },
        secret: 'abc',
      }).success,
    ).toBe(false);
  });

  it('refuses a Slack or Teams secret that is not an https URL, and a webhook URL with a query or credentials', () => {
    expect(
      createNotificationChannelSchema.safeParse({
        kind: 'slack',
        name: 'x',
        config: {},
        secret: 'http://hooks.slack.test/services/x',
      }).success,
    ).toBe(false);
    expect(
      createNotificationChannelSchema.safeParse({
        kind: 'webhook',
        name: 'x',
        config: { url: 'https://user:pass@hooks.example.test/in' },
        secret: 'k'.repeat(32),
      }).success,
    ).toBe(false);
    expect(
      createNotificationChannelSchema.safeParse({
        kind: 'webhook',
        name: 'x',
        config: { url: 'https://hooks.example.test/in?token=abc' },
        secret: 'k'.repeat(32),
      }).success,
    ).toBe(false);
    expect(publicHttpsUrlSchema.safeParse('https://hooks.example.test/in').success).toBe(true);
  });

  it('validates email addresses and rejects an empty recipient list', () => {
    expect(parseNotificationChannelConfig('email', { addresses: ['soc@example.test'] })).toEqual({
      addresses: ['soc@example.test'],
    });
    expect(() => parseNotificationChannelConfig('email', { addresses: [] })).toThrow();
    expect(() =>
      parseNotificationChannelConfig('email', { addresses: ['not-an-address'] }),
    ).toThrow();
  });

  it('applies the PagerDuty and Opsgenie region default and refuses an unknown region', () => {
    expect(parseNotificationChannelConfig('pagerduty', {})).toEqual({ region: 'us' });
    expect(parseNotificationChannelConfig('opsgenie', { region: 'eu' })).toEqual({ region: 'eu' });
    expect(() => parseNotificationChannelConfig('opsgenie', { region: 'mars' })).toThrow();
  });

  it('normalises names to NFC and refuses control characters and blank names', () => {
    expect(notificationChannelNameSchema.parse('Café')).toBe('Café');
    expect(notificationChannelNameSchema.safeParse('bad\nname').success).toBe(false);
    expect(notificationChannelNameSchema.safeParse('bad name').success).toBe(false);
    expect(notificationChannelNameSchema.safeParse('   ').success).toBe(false);
    expect(notificationChannelNameSchema.safeParse('x'.repeat(121)).success).toBe(false);
  });

  it('keeps the PATCH body strict and refuses a kind change', () => {
    expect(updateNotificationChannelSchema.safeParse({ kind: 'email' }).success).toBe(false);
    expect(updateNotificationChannelSchema.safeParse({ status: 'disabled' }).success).toBe(true);
    expect(updateNotificationChannelSchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });

  it('answers the force flag as a boolean and refuses anything else', () => {
    expect(deleteNotificationChannelQuerySchema.parse({})).toEqual({ force: false });
    expect(deleteNotificationChannelQuerySchema.parse({ force: 'true' })).toEqual({ force: true });
    expect(deleteNotificationChannelQuerySchema.safeParse({ force: 'yes' }).success).toBe(false);
  });

  it('views carry an opaque ref and no field that could hold secret material', () => {
    const view = notificationChannelViewSchema.parse({
      id: USER_ID,
      kind: 'webhook',
      name: 'Ops',
      status: 'active',
      config: { url: 'https://hooks.example.test/in' },
      secretRef: `bw-secret://${USER_ID}/${USER_ID}`,
      createdBy: USER_ID,
      createdAt: '2026-10-30T09:00:00.000Z',
      updatedAt: '2026-10-30T09:00:00.000Z',
    });
    expect(Object.keys(view).sort()).toEqual(
      [
        'config',
        'createdAt',
        'createdBy',
        'id',
        'kind',
        'name',
        'secretRef',
        'status',
        'updatedAt',
      ].sort(),
    );
    expect(notificationChannelViewSchema.safeParse({ ...view, secret: 'plaintext' }).success).toBe(
      false,
    );
  });
});
