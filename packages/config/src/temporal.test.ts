import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import { parseTemporalConfig, temporalConfigSchema } from './temporal.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
}

describe('parseTemporalConfig', () => {
  it('applies the documented development defaults', () => {
    expect(parseTemporalConfig({ NODE_ENV: 'development' })).toEqual({
      address: 'temporal:7233',
      namespace: 'blackwing',
      tls: { enabled: false },
    });
    expect(temporalConfigSchema.parse({}).TEMPORAL_NAMESPACE).toBe('blackwing');
  });

  it('reads explicit values and TLS paths', () => {
    const config = parseTemporalConfig({
      NODE_ENV: 'production',
      TEMPORAL_ADDRESS: 'temporal.internal:7233',
      TEMPORAL_NAMESPACE: 'bw-prod',
      TEMPORAL_TLS_ENABLED: 'true',
      TEMPORAL_CLIENT_CERT_PATH: '/etc/tls/c.pem',
      TEMPORAL_CLIENT_KEY_PATH: '/etc/tls/k.pem',
    });
    expect(config).toEqual({
      address: 'temporal.internal:7233',
      namespace: 'bw-prod',
      tls: { enabled: true, clientCertPath: '/etc/tls/c.pem', clientKeyPath: '/etc/tls/k.pem' },
    });
  });

  it.each(['', 'no-port', 'http://temporal:7233', 'host:0', 'host:70000', 'user:pw@host:7233'])(
    'rejects invalid TEMPORAL_ADDRESS %j with TEMPORAL_CONFIG_INVALID',
    (value) => {
      expect(codeOf(() => parseTemporalConfig({ NODE_ENV: 'test', TEMPORAL_ADDRESS: value }))).toBe(
        'TEMPORAL_CONFIG_INVALID',
      );
    },
  );

  it('rejects an invalid namespace', () => {
    expect(
      codeOf(() => parseTemporalConfig({ NODE_ENV: 'test', TEMPORAL_NAMESPACE: 'bad ns' })),
    ).toBe('TEMPORAL_CONFIG_INVALID');
  });

  it.each(['staging', 'production', undefined])(
    'never silently defaults the address when NODE_ENV=%s',
    (nodeEnv) => {
      const env = nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv };
      expect(codeOf(() => parseTemporalConfig(env))).toBe('TEMPORAL_CONFIG_INVALID');
      expect(codeOf(() => parseTemporalConfig({ ...env, TEMPORAL_ADDRESS: 'temporal:7233' }))).toBe(
        'TEMPORAL_CONFIG_INVALID',
      );
    },
  );

  it('does not echo values in the error message', () => {
    let message = '';
    try {
      parseTemporalConfig({ NODE_ENV: 'test', TEMPORAL_ADDRESS: 'secret-host-without-port' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('secret-host');
  });

  it('requires both certificate paths when TLS is enabled', () => {
    const base = { NODE_ENV: 'test', TEMPORAL_TLS_ENABLED: 'true' };
    expect(codeOf(() => parseTemporalConfig(base))).toBe('TEMPORAL_TLS_MISCONFIGURED');
    expect(codeOf(() => parseTemporalConfig({ ...base, TEMPORAL_CLIENT_CERT_PATH: '/c.pem' }))).toBe(
      'TEMPORAL_TLS_MISCONFIGURED',
    );
    expect(
      codeOf(() =>
        parseTemporalConfig({
          ...base,
          TEMPORAL_CLIENT_CERT_PATH: '/c.pem',
          TEMPORAL_CLIENT_KEY_PATH: ' ',
        }),
      ),
    ).toBe('TEMPORAL_TLS_MISCONFIGURED');
  });
});
