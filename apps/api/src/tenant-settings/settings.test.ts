import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { REDACTED, ValidationError } from '@blackwing/errors';

import { INVALID_TIMEZONE_CODE } from './errors.js';
import {
  applyTenantSettingsPatch,
  diffTenantSettings,
  parseStoredSettings,
  parseTenantSettingsPatch,
  redactTenantSettingsChanges,
  tenantSettingsEtag,
} from './settings.js';
import { ApiProblemError } from '../errors/problem-errors.js';

/** The error a synchronous call throws, or undefined when it returns. */
function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const SETTINGS = parseStoredSettings({});
const AT = new Date('2026-10-01T10:00:00.000Z');

describe('tenantSettingsEtag', () => {
  it('is a quoted strong ETag, stable for the same settings and instant', () => {
    const etag = tenantSettingsEtag(SETTINGS, AT);
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(tenantSettingsEtag(parseStoredSettings({}), new Date(AT))).toBe(etag);
  });

  it('changes when the settings change or the instant of the last change moves', () => {
    const etag = tenantSettingsEtag(SETTINGS, AT);
    expect(tenantSettingsEtag(parseStoredSettings({ weekStartsOn: 1 }), AT)).not.toBe(etag);
    expect(tenantSettingsEtag(SETTINGS, new Date(AT.getTime() + 1))).not.toBe(etag);
  });

  it('is not a version number (it is a hash, so it never reveals a counter)', () => {
    expect(tenantSettingsEtag(SETTINGS, AT)).not.toMatch(/^"v\d+"$/);
  });
});

describe('parseStoredSettings', () => {
  it('applies the defaults to a stored empty object', () => {
    expect(parseStoredSettings({})).toEqual({
      displayTimezone: 'UTC',
      defaultAssessmentMode: 'grey',
    });
  });

  it('throws on a stored value that no longer matches the schema (fail closed)', () => {
    expect(() => parseStoredSettings({ region: 'eu-west-1' })).toThrow(ZodError);
  });
});

describe('parseTenantSettingsPatch', () => {
  it('returns the valid patch', () => {
    expect(parseTenantSettingsPatch({ displayTimezone: 'Europe/Berlin' })).toEqual({
      displayTimezone: 'Europe/Berlin',
    });
  });

  it('answers an unknown zone with invalid_timezone', () => {
    const error = errorOf(() => parseTenantSettingsPatch({ displayTimezone: 'Mars/Olympus' }));
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).problemCode).toBe(INVALID_TIMEZONE_CODE);
    expect(INVALID_TIMEZONE_CODE).toBe('invalid_timezone');
  });

  it.each([
    ['an unknown key', { isAdmin: true }],
    ['region, which is read-only', { region: 'us-east-1' }],
    ['a bad assessment mode', { defaultAssessmentMode: 'red' }],
    ['a body that is not an object', ['displayTimezone']],
    ['no body', undefined],
  ])('answers %s with a validation error that names fields only', (_label, body) => {
    expect(() => parseTenantSettingsPatch(body)).toThrow(ValidationError);
  });

  it('names the offending field without echoing the submitted value', () => {
    const error = errorOf(() =>
      parseTenantSettingsPatch({ defaultAssessmentMode: 'secret-value-123' }),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain('defaultAssessmentMode');
    expect((error as ValidationError).detail).not.toContain('secret-value-123');
  });
});

describe('applyTenantSettingsPatch', () => {
  it('sets, changes and removes keys, leaving the others', () => {
    const current = parseStoredSettings({
      displayTimezone: 'Europe/Berlin',
      defaultNotificationEmail: 'ops@example.com',
      weekStartsOn: 1,
    });
    expect(
      applyTenantSettingsPatch(current, {
        displayTimezone: 'America/New_York',
        defaultNotificationEmail: null,
      }),
    ).toEqual({
      displayTimezone: 'America/New_York',
      defaultAssessmentMode: 'grey',
      weekStartsOn: 1,
    });
  });

  it('leaves the settings unchanged for an empty patch', () => {
    expect(applyTenantSettingsPatch(SETTINGS, {})).toEqual(SETTINGS);
  });
});

describe('diffTenantSettings', () => {
  it('lists only the keys that differ, in sorted order, with both values', () => {
    const after = parseStoredSettings({ displayTimezone: 'Asia/Tokyo', weekStartsOn: 0 });
    expect(diffTenantSettings(SETTINGS, after)).toEqual({
      displayTimezone: { from: 'UTC', to: 'Asia/Tokyo' },
      weekStartsOn: { from: null, to: 0 },
    });
  });

  it('is empty when nothing changed', () => {
    expect(diffTenantSettings(SETTINGS, parseStoredSettings({}))).toEqual({});
  });
});

describe('redactTenantSettingsChanges', () => {
  it('keeps the key of a personal-data change and redacts both values', () => {
    const redacted = redactTenantSettingsChanges({
      defaultNotificationEmail: { from: 'old@example.com', to: 'new@example.com' },
    });
    expect(redacted).toEqual({
      defaultNotificationEmail: { from: REDACTED, to: REDACTED },
    });
    expect(JSON.stringify(redacted)).not.toContain('example.com');
  });

  it('keeps an unset personal value as null (it reveals nothing)', () => {
    expect(
      redactTenantSettingsChanges({
        defaultNotificationEmail: { from: null, to: 'new@example.com' },
      }),
    ).toEqual({ defaultNotificationEmail: { from: null, to: REDACTED } });
  });

  it('passes non-personal values through unchanged', () => {
    const changes = { displayTimezone: { from: 'UTC', to: 'Europe/Berlin' } };
    expect(redactTenantSettingsChanges(changes)).toEqual(changes);
  });
});
