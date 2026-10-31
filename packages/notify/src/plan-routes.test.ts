import { describe, expect, it } from 'vitest';

import {
  createChannelRegistry,
  type NotificationChannel,
  validateWithKindSchema,
} from './channel.js';
import { type PlanInput, planDeliveries, type RoutableChannel } from './plan.js';

import type { RouteRule } from './routing.js';
import type { NotificationChannelKind, NotificationRequest } from '@blackwing/contracts';

/** Routing rules (NOTIFY-011) through the planner: the rule modes, the critical fallback and the recipient narrowing. */

const TENANT = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a77';
const NOTIFICATION = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8b01';
const CONSOLE = 'https://console.blackwing.example';
const CH_EMAIL = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8c01';
const CH_SLACK = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8c02';
const CH_OFF = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8c03';
const UNKNOWN_CH = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8c09';
const RULE_1 = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8d01';
const RULE_2 = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8d02';
const ASSET = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8e01';
const OTHER_ASSET = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8e02';

const impl = (kind: NotificationChannelKind, supportsActions = false): NotificationChannel => ({
  kind,
  supportsActions,
  validate: (config) => validateWithKindSchema(kind, config),
  send: () => Promise.resolve({ ok: true }),
});
const registry = createChannelRegistry([impl('email'), impl('slack', true)]);

const EMAIL_CH = (
  id: string,
  addresses: string[],
  status: 'active' | 'disabled' = 'active',
): RoutableChannel => ({
  id,
  tenantId: TENANT,
  kind: 'email',
  config: { addresses },
  status,
});
const SLACK_CH: RoutableChannel = {
  id: CH_SLACK,
  tenantId: TENANT,
  kind: 'slack',
  config: {},
  status: 'active',
};

const request = (overrides: Partial<NotificationRequest> = {}): NotificationRequest => ({
  tenantId: TENANT,
  event: 'run.failed',
  severity: 'high',
  subject: 'Run failed',
  body: {},
  ...overrides,
});

const rule = (overrides: Partial<RouteRule> & Pick<RouteRule, 'id' | 'channelId'>): RouteRule => ({
  event: '*',
  assetId: null,
  severityMin: 'info',
  recipientSpec: {},
  enabled: true,
  priority: 0,
  ...overrides,
});

function plan(overrides: Partial<PlanInput> = {}) {
  return planDeliveries({
    request: request(),
    notificationId: NOTIFICATION,
    channels: [EMAIL_CH(CH_EMAIL, ['sec@example.com', 'lead@example.com']), SLACK_CH],
    registry,
    consoleUrl: CONSOLE,
    adminRecipients: ['admin@example.com'],
    ...overrides,
  });
}

const targets = (result: ReturnType<typeof plan>) => result.deliveries.map((d) => d.channelId);

describe('planDeliveries with routing rules', () => {
  it('broadcasts to every active channel when the tenant has no enabled rule', () => {
    const result = plan({ routes: [rule({ id: RULE_1, channelId: CH_SLACK, enabled: false })] });
    expect(targets(result)).toEqual([CH_EMAIL, CH_SLACK]);
    expect(result.matchedRules).toBe(0);
  });

  it('delivers only to the channels that matching rules name', () => {
    const result = plan({
      routes: [rule({ id: RULE_1, channelId: CH_SLACK, event: 'run.failed' })],
    });
    expect(targets(result)).toEqual([CH_SLACK]);
    expect(result.matchedRules).toBe(1);
    expect(result.unrouted).toBe(false);
  });

  it('lets an asset-specific rule override the wildcard rule for that asset', () => {
    const routes = [
      rule({ id: RULE_1, channelId: CH_SLACK, assetId: null }),
      rule({ id: RULE_2, channelId: CH_EMAIL, assetId: ASSET }),
    ];
    const forAsset = plan({ request: request({ assetId: ASSET }), routes });
    expect(targets(forAsset)).toEqual([CH_EMAIL]);
    const forOther = plan({ request: request({ assetId: OTHER_ASSET }), routes });
    expect(targets(forOther)).toEqual([CH_SLACK]);
  });

  it('sends one message per channel even when two rules name it', () => {
    const routes = [
      rule({ id: RULE_1, channelId: CH_SLACK }),
      rule({ id: RULE_2, channelId: CH_SLACK, priority: 9 }),
    ];
    const result = plan({ routes });
    expect(targets(result)).toEqual([CH_SLACK]);
    expect(result.matchedRules).toBe(2);
  });

  it('skips a rule that names a disabled channel and still uses the other rules', () => {
    const routes = [
      rule({ id: RULE_1, channelId: CH_OFF, priority: 9 }),
      rule({ id: RULE_2, channelId: CH_SLACK }),
    ];
    const result = plan({
      channels: [
        EMAIL_CH(CH_EMAIL, ['sec@example.com']),
        { ...SLACK_CH },
        EMAIL_CH(CH_OFF, ['x@example.com'], 'disabled'),
      ],
      routes,
    });
    expect(targets(result)).toEqual([CH_SLACK]);
    expect(result.skipped).toEqual([{ channelId: CH_OFF, reason: 'disabled' }]);
  });

  it('skips and reports a rule that names a channel the tenant does not hold', () => {
    const routes = [
      rule({ id: RULE_1, channelId: UNKNOWN_CH }),
      rule({ id: RULE_2, channelId: CH_SLACK }),
    ];
    const result = plan({ routes });
    expect(targets(result)).toEqual([CH_SLACK]);
    expect(result.skipped).toEqual([{ channelId: UNKNOWN_CH, reason: 'unknown_channel' }]);
  });

  it('reports unrouted for a non-critical event that no rule matches', () => {
    const result = plan({
      request: request({ event: 'run.completed' }),
      routes: [rule({ id: RULE_1, channelId: CH_SLACK, event: 'run.failed' })],
    });
    expect(result.deliveries).toEqual([]);
    expect(result.unrouted).toBe(true);
    expect(result.fallback).toBe(false);
  });

  it.each(['kill.fired', 'gate2.exception', 'soc.test_window'] as const)(
    'falls back to the tenant admins when a critical %s matches no rule',
    (event) => {
      const result = plan({
        request: request({ event, severity: 'critical' }),
        routes: [rule({ id: RULE_1, channelId: CH_SLACK, event: 'run.failed' })],
      });
      expect(result.fallback).toBe(true);
      expect(result.unrouted).toBe(false);
      expect(result.deliveries.map((d) => d.channelId)).toEqual([null]);
      expect(result.deliveries[0]?.payload.recipients).toEqual(['admin@example.com']);
      expect(result.matchedRules).toBe(0);
    },
  );

  it('uses the channel audience when a rule names no recipients', () => {
    const result = plan({ routes: [rule({ id: RULE_1, channelId: CH_EMAIL })] });
    expect(result.deliveries[0]?.payload.recipients).toEqual([
      'sec@example.com',
      'lead@example.com',
    ]);
  });

  it('narrows an e-mail delivery to the rule addresses that the channel already holds', () => {
    const routes = [
      rule({
        id: RULE_1,
        channelId: CH_EMAIL,
        recipientSpec: { emails: ['LEAD@example.com', 'stranger@example.com'] },
      }),
    ];
    const result = plan({ routes });
    expect(result.deliveries[0]?.payload.recipients).toEqual(['lead@example.com']);
  });

  it('narrows to on-call group members, and never widens past the channel audience', () => {
    const routes = [
      rule({ id: RULE_1, channelId: CH_EMAIL, recipientSpec: { onCallGroup: 'soc-primary' } }),
    ];
    const result = plan({
      routes,
      groups: { 'soc-primary': ['sec@example.com', 'outsider@example.com'] },
    });
    expect(result.deliveries[0]?.payload.recipients).toEqual(['sec@example.com']);
  });

  it('uses the channel audience when the named on-call group has no members', () => {
    const routes = [
      rule({ id: RULE_1, channelId: CH_EMAIL, recipientSpec: { onCallGroup: 'empty' } }),
    ];
    const result = plan({ routes, groups: { empty: [] } });
    expect(result.deliveries[0]?.payload.recipients).toEqual([
      'sec@example.com',
      'lead@example.com',
    ]);
  });

  it('skips an e-mail channel when the rule narrows it to none of its addresses', () => {
    const routes = [
      rule({ id: RULE_1, channelId: CH_EMAIL, recipientSpec: { emails: ['nobody@example.com'] } }),
    ];
    const result = plan({ routes });
    expect(result.deliveries).toEqual([]);
    expect(result.skipped).toEqual([{ channelId: CH_EMAIL, reason: 'no_matching_recipient' }]);
  });

  it('keeps the rule recipients out of a non-e-mail channel', () => {
    const routes = [
      rule({ id: RULE_1, channelId: CH_SLACK, recipientSpec: { emails: ['lead@example.com'] } }),
    ];
    const result = plan({ routes });
    expect(result.deliveries[0]?.channelId).toBe(CH_SLACK);
    expect(result.deliveries[0]?.payload.recipients).toBeUndefined();
  });
});
