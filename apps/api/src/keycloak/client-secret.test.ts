import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import { createOpenBaoClientSecretReader } from './client-secret.js';
import { fakeOpenBao, SECRET_PATH } from './fixtures.test-helpers.js';

describe('createOpenBaoClientSecretReader', () => {
  it('reads client_secret from the KV v2 data.data map at the configured path', async () => {
    const openBao = fakeOpenBao({ secret: 'secret-v1' });
    const read = createOpenBaoClientSecretReader(openBao, SECRET_PATH);

    expect(await read()).toBe('secret-v1');
    expect(openBao.reads).toEqual([`GET ${SECRET_PATH}`]);
  });

  it('fails closed with CONFIG_INVALID when the secret is absent', async () => {
    const read = createOpenBaoClientSecretReader(fakeOpenBao({ secret: undefined }), SECRET_PATH);
    const error = await read().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('CONFIG_INVALID');
  });

  it('fails closed when the stored secret is empty or has the wrong shape', async () => {
    const wrongShape = {
      request: () => Promise.resolve({ status: 200, data: { client_secret: 'flat-not-kv2' } }),
    };
    const empty = {
      request: () => Promise.resolve({ status: 200, data: { data: { client_secret: '' } } }),
    };
    for (const openBao of [wrongShape, empty]) {
      const error = await createOpenBaoClientSecretReader(openBao, SECRET_PATH)().catch(
        (e: unknown) => e,
      );
      expect((error as AppError).code).toBe('CONFIG_INVALID');
    }
  });

  it('never puts the secret value in the error message', async () => {
    const wrongShape = {
      request: () =>
        Promise.resolve({ status: 200, data: { data: { client_secret: 'LEAK-ME', extra: 1 } } }),
    };
    // A valid value is returned, never echoed; an invalid one must not appear in the message either.
    const invalid = {
      request: () => Promise.resolve({ status: 200, data: { data: { client_secret: 7 } } }),
    };
    expect(await createOpenBaoClientSecretReader(wrongShape, SECRET_PATH)()).toBe('LEAK-ME');
    const error = await createOpenBaoClientSecretReader(invalid, SECRET_PATH)().catch(
      (e: unknown) => e,
    );
    expect((error as AppError).message).not.toContain('LEAK-ME');
  });
});
