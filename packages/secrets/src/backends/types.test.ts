import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '@blackwing/errors';

import { assertTenantId, observe, parseBackendConfig } from './types.js';

function thrownOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

describe('observe', () => {
  it('counts ok and error results and runs under the secret.backend span', async () => {
    const records: string[] = [];
    const spans: string[] = [];
    const telemetry = {
      metrics: {
        record: (kind: string, op: string, result: string) =>
          records.push(`${kind}/${op}/${result}`),
      },
      span: <T>(name: string, fn: () => Promise<T>) => {
        spans.push(name);
        return fn();
      },
    };
    await expect(observe(telemetry, 'vault', 'get', () => Promise.resolve(1))).resolves.toBe(1);
    await expect(
      observe(telemetry, 'vault', 'put', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(records).toEqual(['vault/get/ok', 'vault/put/error']);
    expect(spans).toEqual(['secret.backend', 'secret.backend']);
  });

  it('rethrows the original error and works with no telemetry configured', async () => {
    const failure = new AppError('KEK_UNAVAILABLE', 'down');
    await expect(observe({}, 'openbao', 'wrap', () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
  });
});

describe('assertTenantId', () => {
  it.each(['acme', 'tenant-1', 'a_b'])('accepts %s', (id) => {
    expect(() => {
      assertTenantId(id);
    }).not.toThrow();
  });

  it.each(['', '../x', 'A', 'a/b', 'a b', 'a*'])('rejects %j', (id) => {
    expect(
      codeOf(() => {
        assertTenantId(id);
      }),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('parseBackendConfig', () => {
  const schema = z.object({ address: z.url(), tokenRef: z.string() }).strict();

  it('accepts a valid config', () => {
    expect(() => {
      parseBackendConfig(schema, {
        address: 'https://vault.example.com',
        tokenRef: 'bw-secret://t/s',
      });
    }).not.toThrow();
  });

  it('names the bad field and never echoes its value', () => {
    const secret = 'hunter2-plaintext-token';
    const thrown = thrownOf(() => {
      parseBackendConfig(schema, { address: 'not a url', tokenRef: secret, extra: 1 });
    });
    expect(thrown).toBeInstanceOf(AppError);
    const message = (thrown as AppError).message;
    expect((thrown as AppError).code).toBe('VALIDATION_FAILED');
    expect(message).toContain('address');
    expect(message).not.toContain(secret);
  });

  it('rejects a non-object config', () => {
    expect(
      codeOf(() => {
        parseBackendConfig(schema, 'string');
      }),
    ).toBe('VALIDATION_FAILED');
  });
});
