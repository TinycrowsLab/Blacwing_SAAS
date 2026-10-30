import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DISPLAY_TIMEZONE,
  isIanaTimeZone,
  TENANT_SETTINGS_PII_KEYS,
  tenantSettingsPatchSchema,
  tenantSettingsSchema,
} from './tenant-settings.js';

describe('isIanaTimeZone', () => {
  it.each([
    'UTC',
    'Europe/Berlin',
    'America/New_York',
    'Asia/Kolkata',
    'Etc/GMT+5',
    'America/Port-au-Prince',
  ])('accepts the canonical zone %s', (zone) => {
    expect(isIanaTimeZone(zone)).toBe(true);
  });

  it.each([
    ['an unknown zone', 'Mars/Olympus'],
    ['a lower-case spelling of a zone', 'utc'],
    ['a mixed-case spelling of a zone', 'europe/Berlin'],
    ['an offset, not a zone name', '+05:00'],
    ['a zone name with a trailing space', 'Europe/Berlin '],
    ['a zone name with a dot segment', 'Europe/../Berlin'],
    ['the empty string', ''],
    ['a path-like string', '../../etc/passwd'],
    ['a zone with a NUL byte', 'UTC\u0000'],
  ])('rejects %s', (_label, zone) => {
    expect(isIanaTimeZone(zone)).toBe(false);
  });
});

describe('tenantSettingsSchema', () => {
  it('applies the defaults to an empty object', () => {
    expect(tenantSettingsSchema.parse({})).toEqual({
      displayTimezone: DEFAULT_DISPLAY_TIMEZONE,
      defaultAssessmentMode: 'grey',
    });
    expect(DEFAULT_DISPLAY_TIMEZONE).toBe('UTC');
  });

  it('accepts a complete, valid settings object', () => {
    const value = {
      displayTimezone: 'Europe/Berlin',
      defaultAssessmentMode: 'black',
      defaultNotificationEmail: 'secops@example.com',
      weekStartsOn: 1,
    };
    expect(tenantSettingsSchema.parse(value)).toEqual(value);
  });

  it.each([
    ['an unknown key (setting smuggling)', { isAdmin: true }],
    ['region, which is read-only', { region: 'eu-west-1' }],
    ['a bad timezone', { displayTimezone: 'Mars/Olympus' }],
    ['a bad assessment mode', { defaultAssessmentMode: 'red' }],
    ['a bad email', { defaultNotificationEmail: 'not-an-email' }],
    ['weekStartsOn outside 0|1', { weekStartsOn: 7 }],
  ])('rejects %s', (_label, value) => {
    expect(tenantSettingsSchema.safeParse(value).success).toBe(false);
  });

  it('lists the personal-data keys that audit and logs must redact', () => {
    expect(TENANT_SETTINGS_PII_KEYS).toEqual(['defaultNotificationEmail', 'supportContactEmail']);
  });
});

describe('tenantSettingsPatchSchema', () => {
  it('accepts an empty patch as a no-op', () => {
    expect(tenantSettingsPatchSchema.parse({})).toEqual({});
  });

  it('lets null clear the optional keys and rejects clearing the required ones', () => {
    expect(
      tenantSettingsPatchSchema.parse({ defaultNotificationEmail: null, weekStartsOn: null }),
    ).toEqual({ defaultNotificationEmail: null, weekStartsOn: null });
    expect(tenantSettingsPatchSchema.safeParse({ displayTimezone: null }).success).toBe(false);
    expect(tenantSettingsPatchSchema.safeParse({ defaultAssessmentMode: null }).success).toBe(
      false,
    );
  });

  it('rejects unknown keys and region (strict)', () => {
    expect(tenantSettingsPatchSchema.safeParse({ region: 'us-east-1' }).success).toBe(false);
    expect(tenantSettingsPatchSchema.safeParse({ tenantId: 'x' }).success).toBe(false);
  });

  it('rejects an invalid timezone with a custom issue on displayTimezone', () => {
    const result = tenantSettingsPatchSchema.safeParse({ displayTimezone: 'Mars/Olympus' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: 'custom', path: ['displayTimezone'] }),
    ]);
  });
});
