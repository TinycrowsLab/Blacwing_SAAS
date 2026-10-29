import { describe, expect, it } from 'vitest';

import { isAppError } from '@blackwing/errors';

import { loadApiConfig } from '../config.js';
import { assertStepUp, DEFAULT_STEPUP_POLICY, type StepUpPolicy } from './step-up.js';

const minimal = { NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' };

const NOW_MS = Date.parse('2026-11-02T09:00:00.000Z');
const NOW_S = NOW_MS / 1000;
const POLICY: StepUpPolicy = { maxAgeS: 300, acr: 'strong' };

/** What `fn` threw, or `undefined` when it returned. */
function thrownBy(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The code the step-up check refuses with, or `undefined` when it accepts. */
function refusal(evidence: Parameters<typeof assertStepUp>[0]): string | undefined {
  try {
    assertStepUp(evidence, POLICY, NOW_MS);
  } catch (error) {
    return isAppError(error) ? error.code : 'UNKNOWN';
  }
  return undefined;
}

describe('assertStepUp', () => {
  it('accepts a fresh login with the required acr', () => {
    expect(refusal({ acr: 'strong', authTime: NOW_S - 10 })).toBeUndefined();
  });

  it('accepts a login at exactly the maximum age, and refuses one second older', () => {
    expect(refusal({ acr: 'strong', authTime: NOW_S - 300 })).toBeUndefined();
    expect(refusal({ acr: 'strong', authTime: NOW_S - 301 })).toBe('AUTHZ_STEPUP_REQUIRED');
  });

  it('refuses without a fresh login: a missing auth_time, a missing acr, or the wrong acr', () => {
    expect(refusal({})).toBe('AUTHZ_STEPUP_REQUIRED');
    expect(refusal({ acr: 'strong' })).toBe('AUTHZ_STEPUP_REQUIRED');
    expect(refusal({ authTime: NOW_S })).toBe('AUTHZ_STEPUP_REQUIRED');
    expect(refusal({ acr: '1', authTime: NOW_S })).toBe('AUTHZ_STEPUP_REQUIRED');
    expect(refusal({ acr: 'STRONG', authTime: NOW_S })).toBe('AUTHZ_STEPUP_REQUIRED');
  });

  it('refuses an auth_time in the future: the clock or the token cannot be trusted', () => {
    expect(refusal({ acr: 'strong', authTime: NOW_S + 1 })).toBe('AUTHZ_STEPUP_REQUIRED');
  });

  it('carries the challenge in the detail: the acr and the age the client must satisfy', () => {
    const error = thrownBy(() => {
      assertStepUp({}, POLICY, NOW_MS);
    });
    expect(isAppError(error) && error.code).toBe('AUTHZ_STEPUP_REQUIRED');
    expect(isAppError(error) && error.detail).toBe(
      'Re-authenticate with acr "strong" within the last 300 seconds, then retry.',
    );
  });
});

describe('the AUTHZ_STEPUP_* configuration', () => {
  it('defaults to 300 seconds and the realm strong acr, and reads the two keys', () => {
    expect(DEFAULT_STEPUP_POLICY).toEqual({ maxAgeS: 300, acr: 'strong' });
    const config = loadApiConfig(minimal);
    expect(config).toMatchObject({ AUTHZ_STEPUP_MAX_AGE_S: 300, AUTHZ_STEPUP_ACR: 'strong' });
    expect(
      loadApiConfig({ ...minimal, AUTHZ_STEPUP_MAX_AGE_S: '120', AUTHZ_STEPUP_ACR: 'urn:mfa' }),
    ).toMatchObject({ AUTHZ_STEPUP_MAX_AGE_S: 120, AUTHZ_STEPUP_ACR: 'urn:mfa' });
  });

  it('fails closed on a malformed age or an empty acr', () => {
    for (const bad of ['0', '3601', 'soon', '1.5']) {
      expect(() => loadApiConfig({ ...minimal, AUTHZ_STEPUP_MAX_AGE_S: bad })).toThrow();
    }
    expect(() => loadApiConfig({ ...minimal, AUTHZ_STEPUP_ACR: '   ' })).toThrow();
  });
});
