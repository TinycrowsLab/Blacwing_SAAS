import { describe, expect, it } from 'vitest';

import {
  ORG_NAME_MAX_LENGTH,
  orgProfileSchema,
  orgSettingsPatchSchema,
  orgSettingsSchema,
} from './org-settings.js';

const VALID = {
  name: 'Acme Security',
  defaultTimezone: 'Europe/Berlin',
  supportContactEmail: 'soc@acme.test',
};

describe('orgSettingsSchema', () => {
  it('accepts a valid profile', () => {
    expect(orgSettingsSchema.parse(VALID)).toEqual(VALID);
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a whitespace-only name', { name: '   ' }],
    ['a name over the limit', { name: 'x'.repeat(ORG_NAME_MAX_LENGTH + 1) }],
    ['a name with a line break', { name: 'Acme\nSecurity' }],
    ['a name with a NUL byte', { name: 'Acme\u0000' }],
    ['an unknown time zone', { defaultTimezone: 'Mars/Olympus' }],
    ['a lower-case time zone', { defaultTimezone: 'europe/berlin' }],
    ['an offset instead of a zone', { defaultTimezone: '+05:00' }],
    ['a malformed e-mail', { supportContactEmail: 'not-an-email' }],
    ['a read-only slug', { slug: 'acme' }],
    ['a read-only region', { region: 'us-east-1' }],
    ['an unknown key', { tenantId: '0198f0a0-0000-7000-8000-00000000000a' }],
  ])('rejects %s', (_label, override) => {
    expect(orgSettingsSchema.safeParse({ ...VALID, ...override }).success).toBe(false);
  });

  it('accepts a name of exactly the limit, trimmed, and Unicode (RTL, emoji)', () => {
    expect(orgSettingsSchema.parse({ ...VALID, name: `  ${'x'.repeat(120)}  ` }).name).toHaveLength(
      120,
    );
    expect(orgSettingsSchema.parse({ ...VALID, name: 'شركة الأمن 🛡️' }).name).toBe('شركة الأمن 🛡️');
  });

  it('turns an empty or null support contact into null (cleared)', () => {
    expect(orgSettingsSchema.parse({ ...VALID, supportContactEmail: '' }).supportContactEmail).toBe(
      null,
    );
    expect(
      orgSettingsSchema.parse({ ...VALID, supportContactEmail: null }).supportContactEmail,
    ).toBe(null);
  });
});

describe('orgSettingsPatchSchema', () => {
  it('accepts an empty patch and any subset of the editable fields', () => {
    expect(orgSettingsPatchSchema.parse({})).toEqual({});
    expect(orgSettingsPatchSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });

  it('refuses read-only fields and identifiers from the client', () => {
    expect(orgSettingsPatchSchema.safeParse({ slug: 'other' }).success).toBe(false);
    expect(orgSettingsPatchSchema.safeParse({ region: 'us-east-1' }).success).toBe(false);
    expect(orgSettingsPatchSchema.safeParse({ plan: 'enterprise' }).success).toBe(false);
    expect(orgSettingsPatchSchema.safeParse({ tenantId: 'x' }).success).toBe(false);
  });
});

describe('orgProfileSchema', () => {
  it('describes the read-only fields alongside the editable ones', () => {
    const profile = {
      name: 'Acme',
      slug: 'acme',
      region: 'eu-west-1',
      plan: 'team',
      status: 'active',
      defaultTimezone: 'UTC',
      supportContactEmail: null,
      updatedAt: '2026-10-01T10:00:00.000Z',
    };
    expect(orgProfileSchema.parse(profile)).toEqual(profile);
    expect(orgProfileSchema.safeParse({ ...profile, status: 'archived' }).success).toBe(false);
  });
});
