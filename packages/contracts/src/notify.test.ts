import { describe, expect, it } from 'vitest';

import {
  isAuditedNotificationEvent,
  isCriticalNotificationEvent,
  isSafeActionHref,
  NOTIFICATION_ACTIONS_MAX,
  NOTIFICATION_BODY_KEYS_MAX,
  NOTIFICATION_EVENT_TYPES,
  notificationRequestSchema,
  notifySendPayloadSchema,
} from './notify.js';

const TENANT_ID = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a77';
const RUN_ID = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a78';

const base = {
  tenantId: TENANT_ID,
  event: 'gate2.exception',
  severity: 'high',
  subject: 'Runtime exception waiting',
} as const;

describe('notification request contract (NOTIFY-002)', () => {
  it('lists the eleven events the issue names, in order', () => {
    expect([...NOTIFICATION_EVENT_TYPES]).toEqual([
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
    ]);
  });

  it('accepts a minimal request and defaults the body to an empty object', () => {
    const parsed = notificationRequestSchema.parse(base);
    expect(parsed.body).toEqual({});
    expect(parsed.actions).toBeUndefined();
  });

  it('refuses an unknown event, an unknown field and a missing tenant (fail closed)', () => {
    expect(notificationRequestSchema.safeParse({ ...base, event: 'made.up' }).success).toBe(false);
    expect(notificationRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    const withoutTenant: Record<string, unknown> = { ...base };
    delete withoutTenant.tenantId;
    expect(notificationRequestSchema.safeParse(withoutTenant).success).toBe(false);
    expect(notificationRequestSchema.safeParse({ ...base, tenantId: 'acme' }).success).toBe(false);
  });

  it('refuses control characters and empty or oversized subjects', () => {
    expect(notificationRequestSchema.safeParse({ ...base, subject: '  ' }).success).toBe(false);
    expect(notificationRequestSchema.safeParse({ ...base, subject: 'a\nb' }).success).toBe(false);
    expect(notificationRequestSchema.safeParse({ ...base, subject: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('refuses body field names that are not plain identifiers and too many fields', () => {
    expect(notificationRequestSchema.safeParse({ ...base, body: { 'bad key': 'x' } }).success).toBe(
      false,
    );
    expect(notificationRequestSchema.safeParse({ ...base, body: { Upper: 'x' } }).success).toBe(
      false,
    );
    const tooMany = Object.fromEntries(
      Array.from({ length: NOTIFICATION_BODY_KEYS_MAX + 1 }, (_, i) => [`f${i}`, 'v']),
    );
    expect(notificationRequestSchema.safeParse({ ...base, body: tooMany }).success).toBe(false);
  });

  it('refuses a body value that is an object or contains a newline', () => {
    expect(
      notificationRequestSchema.safeParse({ ...base, body: { nested: { a: 1 } } }).success,
    ).toBe(false);
    expect(notificationRequestSchema.safeParse({ ...base, body: { note: 'a\nb' } }).success).toBe(
      false,
    );
  });

  it('accepts numeric, boolean and null body values', () => {
    const parsed = notificationRequestSchema.parse({
      ...base,
      body: { count: 3, ok: true, missing: null },
    });
    expect(parsed.body).toEqual({ count: 3, ok: true, missing: null });
  });

  it('refuses actions whose href could leave the console or carry credentials', () => {
    const action = (href: string) => ({ ...base, actions: [{ label: 'Open', href }] });
    expect(notificationRequestSchema.safeParse(action('/runs/1')).success).toBe(true);
    expect(
      notificationRequestSchema.safeParse(action('https://console.example.com/a')).success,
    ).toBe(true);
    for (const href of [
      '//evil.example.com/x',
      '/\\evil.example.com',
      'http://console.example.com/a',
      ['java', 'script:alert(1)'].join(''),
      'https://user:pass@console.example.com/a',
      'relative/path',
      '/runs/1\nx',
    ]) {
      expect(notificationRequestSchema.safeParse(action(href)).success, href).toBe(false);
    }
  });

  it('caps the number of actions and refuses a blank action label', () => {
    const many = Array.from({ length: NOTIFICATION_ACTIONS_MAX + 1 }, () => ({
      label: 'Open',
      href: '/runs/1',
    }));
    expect(notificationRequestSchema.safeParse({ ...base, actions: many }).success).toBe(false);
    expect(
      notificationRequestSchema.safeParse({
        ...base,
        actions: [{ label: '   ', href: '/runs/1' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a dedupe key with spaces, an empty key or one longer than 200 characters', () => {
    expect(notificationRequestSchema.safeParse({ ...base, dedupeKey: 'a b' }).success).toBe(false);
    expect(notificationRequestSchema.safeParse({ ...base, dedupeKey: '' }).success).toBe(false);
    expect(
      notificationRequestSchema.safeParse({ ...base, dedupeKey: 'k'.repeat(201) }).success,
    ).toBe(false);
    expect(notificationRequestSchema.safeParse({ ...base, dedupeKey: 'gate2:abc' }).success).toBe(
      true,
    );
  });

  it('accepts recipients only as valid addresses, bounded in count', () => {
    expect(
      notificationRequestSchema.safeParse({ ...base, recipients: ['not-an-address'] }).success,
    ).toBe(false);
    expect(notificationRequestSchema.safeParse({ ...base, recipients: [] }).success).toBe(false);
    expect(
      notificationRequestSchema.safeParse({ ...base, recipients: ['sec@example.com'] }).success,
    ).toBe(true);
  });

  it('accepts optional run and asset ids only as UUIDv7 values', () => {
    expect(notificationRequestSchema.safeParse({ ...base, runId: RUN_ID }).success).toBe(true);
    expect(notificationRequestSchema.safeParse({ ...base, runId: 'run-1' }).success).toBe(false);
  });
});

describe('isSafeActionHref', () => {
  it('allows an app-relative path and an https URL without credentials', () => {
    expect(isSafeActionHref('/gate2/exceptions/abc')).toBe(true);
    expect(isSafeActionHref('https://console.example.com/x?y=1')).toBe(true);
  });

  it('refuses scheme-relative, backslash, non-https and malformed values', () => {
    expect(isSafeActionHref('//evil.example.com')).toBe(false);
    expect(isSafeActionHref('/\\evil.example.com')).toBe(false);
    expect(isSafeActionHref('http://console.example.com')).toBe(false);
    expect(isSafeActionHref('not a url')).toBe(false);
    expect(isSafeActionHref('https://')).toBe(false);
  });
});

describe('event classes', () => {
  it('treats kill and gate2 exception notices as critical, nothing else', () => {
    expect(isCriticalNotificationEvent('kill.fired')).toBe(true);
    expect(isCriticalNotificationEvent('gate2.exception')).toBe(true);
    expect(isCriticalNotificationEvent('run.failed')).toBe(false);
  });

  it('audits gate and kill events, not run or SOC notices', () => {
    expect(isAuditedNotificationEvent('gate1.requested')).toBe(true);
    expect(isAuditedNotificationEvent('gate3.release_requested')).toBe(true);
    expect(isAuditedNotificationEvent('kill.fired')).toBe(true);
    expect(isAuditedNotificationEvent('run.completed')).toBe(false);
    expect(isAuditedNotificationEvent('soc.window_opened')).toBe(false);
  });
});

describe('notify.send payload contract', () => {
  const payload = {
    notificationId: TENANT_ID,
    event: 'kill.fired',
    severity: 'critical',
    channel: { id: null, kind: 'email' },
    recipients: ['admin@example.com'],
    message: { subject: 'Kill fired', text: 'The kill switch was fired.', actions: [] },
  };

  it('accepts a fallback delivery with no channel id', () => {
    expect(notifySendPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('refuses a payload that carries an unknown key, such as a credential', () => {
    expect(
      notifySendPayloadSchema.safeParse({ ...payload, secret: 'https://hooks.example/x' }).success,
    ).toBe(false);
  });

  it('refuses an empty message text', () => {
    expect(
      notifySendPayloadSchema.safeParse({
        ...payload,
        message: { ...payload.message, text: '' },
      }).success,
    ).toBe(false);
  });
});
