import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEK_ROTATION_CRON,
  DEFAULT_SECRET_VERSION_GRACE_MS,
  rotationConfigFromEnv,
} from './rotation-config.js';

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
};

describe('rotationConfigFromEnv', () => {
  it('defaults to a one-hour grace, quarterly KEK rotation and rotation disabled', () => {
    expect(rotationConfigFromEnv({})).toEqual({
      enabled: false,
      graceMs: 3_600_000,
      kekRotationCron: '0 3 1 1,4,7,10 *',
    });
    expect(DEFAULT_SECRET_VERSION_GRACE_MS).toBe(3_600_000);
    expect(DEFAULT_KEK_ROTATION_CRON).toBe('0 3 1 1,4,7,10 *');
  });

  it('reads every setting it names', () => {
    expect(
      rotationConfigFromEnv({
        SECRET_ROTATION_ENABLED: 'true',
        SECRET_VERSION_GRACE_MS: '120000',
        KEK_ROTATION_CRON: '30 2 * * 1',
      }),
    ).toEqual({ enabled: true, graceMs: 120_000, kekRotationCron: '30 2 * * 1' });
  });

  it.each([
    ['SECRET_VERSION_GRACE_MS', { SECRET_VERSION_GRACE_MS: '59999' }],
    ['SECRET_VERSION_GRACE_MS', { SECRET_VERSION_GRACE_MS: '2592000001' }],
    ['SECRET_VERSION_GRACE_MS', { SECRET_VERSION_GRACE_MS: '-1' }],
    ['SECRET_VERSION_GRACE_MS', { SECRET_VERSION_GRACE_MS: '1e6' }],
    ['SECRET_ROTATION_ENABLED', { SECRET_ROTATION_ENABLED: 'yes' }],
    ['SECRET_ROTATION_ENABLED', { SECRET_ROTATION_ENABLED: 'TRUE' }],
    ['KEK_ROTATION_CRON', { KEK_ROTATION_CRON: '0 3 1 *' }],
    ['KEK_ROTATION_CRON', { KEK_ROTATION_CRON: '0 3 1 * * *' }],
    ['KEK_ROTATION_CRON', { KEK_ROTATION_CRON: '0 3 1 * $(id)' }],
  ])('fails closed on a bad %s', (_name, env) => {
    expect(codeOf(() => rotationConfigFromEnv(env))).toBe('CONFIG_INVALID');
  });

  it('keeps the error to the key name, never echoing the value', () => {
    let message = '';
    try {
      rotationConfigFromEnv({ KEK_ROTATION_CRON: 'secret-looking-value' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('KEK_ROTATION_CRON');
    expect(message).not.toContain('secret-looking-value');
  });
});
