import { describe, expect, it } from 'vitest';

import { s3InputObjectStore } from './object-store.js';

import type { S3Client } from '@aws-sdk/client-s3';

function fakeS3(response: (input: unknown) => unknown): Pick<S3Client, 'send'> {
  return {
    send: ((command: { input: unknown }) =>
      Promise.resolve(response(command.input))) as S3Client['send'],
  };
}

describe('s3InputObjectStore', () => {
  it('returns the object bytes for the requested bucket and key', async () => {
    const seen: unknown[] = [];
    const store = s3InputObjectStore(
      fakeS3((input) => {
        seen.push(input);
        return { Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])) } };
      }),
    );
    await expect(store.getBytes('bw-inputs', 'tenant/spec.yaml')).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(seen).toEqual([{ Bucket: 'bw-inputs', Key: 'tenant/spec.yaml' }]);
  });

  it('reads a missing key as null, so the stager can fail closed on it', async () => {
    const missing = Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
    });
    const store = s3InputObjectStore({ send: () => Promise.reject(missing) });
    await expect(store.getBytes('bw-inputs', 'nope')).resolves.toBeNull();
  });

  it('propagates storage outages instead of reporting an empty input set', async () => {
    const outage = Object.assign(new Error('connect ECONNREFUSED'), { name: 'NetworkingError' });
    const store = s3InputObjectStore({ send: () => Promise.reject(outage) });
    await expect(store.getBytes('bw-inputs', 'k')).rejects.toBe(outage);
  });
});
