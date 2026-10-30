import { describe, expect, it } from 'vitest';

import {
  createChannelRegistry,
  type NotificationChannel,
  validateWithKindSchema,
} from './channel.js';

const fake = (kind: NotificationChannel['kind']): NotificationChannel => ({
  kind,
  supportsActions: false,
  validate: (config) => validateWithKindSchema(kind, config),
  send: () => Promise.resolve({ ok: true }),
});

describe('channel registry', () => {
  it('maps each registered kind to its implementation', () => {
    const email = fake('email');
    const slack = fake('slack');
    const registry = createChannelRegistry([email, slack]);
    expect(registry.get('email')).toBe(email);
    expect(registry.get('slack')).toBe(slack);
    expect(registry.kinds).toEqual(['email', 'slack']);
  });

  it('returns undefined for a kind with no implementation, so it cannot be enqueued', () => {
    const registry = createChannelRegistry([fake('email')]);
    expect(registry.get('pagerduty')).toBeUndefined();
  });

  it('refuses two implementations for the same kind at start-up', () => {
    expect(() => createChannelRegistry([fake('email'), fake('email')])).toThrow(
      'notification channel kind "email" is registered twice',
    );
  });

  it('builds an empty registry when no implementation is wired', () => {
    const registry = createChannelRegistry([]);
    expect(registry.kinds).toEqual([]);
    expect(registry.get('email')).toBeUndefined();
  });
});

describe('validateWithKindSchema', () => {
  it('accepts a valid e-mail config and returns its normalised form', () => {
    expect(validateWithKindSchema('email', { addresses: ['sec@example.com'] })).toEqual({
      addresses: ['sec@example.com'],
    });
  });

  it('refuses an e-mail config with an unknown key, so a credential cannot ride along', () => {
    expect(() =>
      validateWithKindSchema('email', { addresses: ['sec@example.com'], webhook_url: 'x' }),
    ).toThrow();
  });

  it('refuses an e-mail config with no addresses', () => {
    expect(() => validateWithKindSchema('email', { addresses: [] })).toThrow();
  });
});
