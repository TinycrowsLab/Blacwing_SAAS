import { describe, expect, it } from 'vitest';

import {
  createChannelRegistry,
  type NotificationChannel,
  validateWithKindSchema,
} from './channel.js';
import { deliveryDedupeKey, type PlanInput, planDeliveries, type RoutableChannel } from './plan.js';

import type { NotificationChannelKind, NotificationRequest } from '@blackwing/contracts';

const TENANT = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a77';
const OTHER_TENANT = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a99';
const NOTIFICATION = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8b01';
const CONSOLE = 'https://console.blackwing.example';

const impl = (kind: NotificationChannelKind, supportsActions = false): NotificationChannel => ({
  kind,
  supportsActions,
  validate: (config) => validateWithKindSchema(kind, config),
  send: () => Promise.resolve({ ok: true }),
});

const registry = createChannelRegistry([impl('email'), impl('slack', true)]);

const email = (
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

const request = (overrides: Partial<NotificationRequest> = {}): NotificationRequest => ({
  tenantId: TENANT,
  event: 'run.completed',
  severity: 'info',
  subject: 'Run completed',
  body: {},
  ...overrides,
});

const CH_A = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8c01';
const CH_B = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8c02';

function plan(overrides: Partial<PlanInput> = {}) {
  return planDeliveries({
    request: request(),
    notificationId: NOTIFICATION,
    channels: [email(CH_A, ['sec@example.com'])],
    registry,
    consoleUrl: CONSOLE,
    adminRecipients: ['admin@example.com'],
    ...overrides,
  });
}

describe('planDeliveries routing', () => {
  it('plans one delivery per active channel of the tenant that the registry serves', () => {
    const result = plan({
      channels: [
        email(CH_A, ['sec@example.com']),
        { id: CH_B, tenantId: TENANT, kind: 'slack', config: {}, status: 'active' },
      ],
    });
    expect(result.deliveries.map((d) => d.channelId)).toEqual([CH_A, CH_B]);
    expect(result.unrouted).toBe(false);
    expect(result.fallback).toBe(false);
    expect(result.skipped).toEqual([]);
  });

  it('skips disabled channels and records why', () => {
    const result = plan({ channels: [email(CH_A, ['sec@example.com'], 'disabled')] });
    expect(result.deliveries).toEqual([]);
    expect(result.skipped).toEqual([{ channelId: CH_A, reason: 'disabled' }]);
  });

  it('never delivers to a channel of another tenant, even when handed one (tenant isolation)', () => {
    const result = plan({
      channels: [{ ...email(CH_A, ['sec@example.com']), tenantId: OTHER_TENANT }],
    });
    expect(result.deliveries).toEqual([]);
    expect(result.skipped).toEqual([{ channelId: CH_A, reason: 'wrong_tenant' }]);
  });

  it('skips a channel whose kind has no registered implementation', () => {
    const result = plan({
      channels: [{ id: CH_B, tenantId: TENANT, kind: 'pagerduty', config: {}, status: 'active' }],
    });
    expect(result.skipped).toEqual([{ channelId: CH_B, reason: 'no_implementation' }]);
  });

  it('skips a stored e-mail config that no longer parses, instead of sending half-formed', () => {
    const result = plan({
      channels: [
        { id: CH_A, tenantId: TENANT, kind: 'email', config: { addresses: [] }, status: 'active' },
      ],
    });
    expect(result.skipped).toEqual([{ channelId: CH_A, reason: 'invalid_config' }]);
  });

  it('skips a non-email channel whose stored config fails its validator', () => {
    const strict: NotificationChannel = {
      ...impl('slack'),
      validate: () => {
        throw new Error('bad config');
      },
    };
    const result = planDeliveries({
      request: request(),
      notificationId: NOTIFICATION,
      channels: [{ id: CH_B, tenantId: TENANT, kind: 'slack', config: {}, status: 'active' }],
      registry: createChannelRegistry([strict]),
      consoleUrl: CONSOLE,
      adminRecipients: [],
    });
    expect(result.skipped).toEqual([{ channelId: CH_B, reason: 'invalid_config' }]);
  });

  it('narrows e-mail to the requested recipients, case-insensitively, and never widens', () => {
    const result = plan({
      request: request({ recipients: ['SEC@example.com'] }),
      channels: [email(CH_A, ['sec@example.com', 'other@example.com'])],
    });
    expect(result.deliveries[0]?.payload.recipients).toEqual(['sec@example.com']);

    const none = plan({
      request: request({ recipients: ['stranger@example.com'] }),
      channels: [email(CH_A, ['sec@example.com'])],
    });
    expect(none.deliveries).toEqual([]);
    expect(none.skipped).toEqual([{ channelId: CH_A, reason: 'no_matching_recipient' }]);
  });

  it('reports unrouted when nothing delivers and the event is not critical', () => {
    const result = plan({ channels: [], request: request({ event: 'run.failed' }) });
    expect(result.deliveries).toEqual([]);
    expect(result.unrouted).toBe(true);
    expect(result.fallback).toBe(false);
  });
});

describe('critical fallback (kill and gate 2)', () => {
  it('falls back to the tenant admins by e-mail when a kill notice reaches no channel', () => {
    const result = plan({
      channels: [],
      request: request({ event: 'kill.fired', severity: 'critical' }),
    });
    expect(result.fallback).toBe(true);
    expect(result.unrouted).toBe(false);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).toMatchObject({
      channelId: null,
      kind: 'email',
      payload: { channel: { id: null, kind: 'email' }, recipients: ['admin@example.com'] },
    });
  });

  it('falls back for a gate 2 exception that every channel skipped', () => {
    const result = plan({
      channels: [email(CH_A, ['sec@example.com'], 'disabled')],
      request: request({ event: 'gate2.exception' }),
    });
    expect(result.fallback).toBe(true);
    expect(result.deliveries[0]?.channelId).toBeNull();
  });

  it('stays unrouted for a critical event when there are no admins to fall back to', () => {
    const result = plan({
      channels: [],
      adminRecipients: [],
      request: request({ event: 'kill.fired' }),
    });
    expect(result.fallback).toBe(false);
    expect(result.unrouted).toBe(true);
  });

  it('does not fall back when a configured channel already delivers', () => {
    const result = plan({ request: request({ event: 'kill.fired' }) });
    expect(result.fallback).toBe(false);
    expect(result.deliveries.map((d) => d.channelId)).toEqual([CH_A]);
  });
});

describe('delivery payload and dedupe keys', () => {
  it('builds a notify.send payload carrying references and the rendered message, never a credential', () => {
    const [delivery] = plan({
      request: request({ actions: [{ label: 'Open', href: '/runs/1' }], body: { count: 2 } }),
    }).deliveries;
    expect(delivery?.payload).toEqual({
      notificationId: NOTIFICATION,
      event: 'run.completed',
      severity: 'info',
      channel: { id: CH_A, kind: 'email' },
      recipients: ['sec@example.com'],
      message: {
        subject: 'Run completed',
        // The e-mail stub does not render buttons, so the link is sent as a text line and no action is dropped.
        text: 'An assessment run completed.\ncount: 2\nOpen: /runs/1',
        actions: [],
      },
    });
  });

  it('keys each delivery by the request key and the target, so a repeat collapses', () => {
    expect(deliveryDedupeKey({ dedupeKey: 'gate2:x' }, NOTIFICATION, CH_A)).toBe(
      `notify:gate2:x:${CH_A}`,
    );
    expect(deliveryDedupeKey({}, NOTIFICATION, 'admins')).toBe(`notify:${NOTIFICATION}:admins`);
    const [delivery] = plan({ request: request({ dedupeKey: 'k1' }) }).deliveries;
    expect(delivery?.dedupeKey).toBe(`notify:k1:${CH_A}`);
  });

  it('is deterministic for the same inputs', () => {
    expect(plan()).toEqual(plan());
  });
});
