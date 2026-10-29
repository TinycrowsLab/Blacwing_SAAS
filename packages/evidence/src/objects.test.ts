import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@blackwing/crypto';
import { ValidationError } from '@blackwing/errors';

import { createObjectReader, type ObjectBytesSource, s3ObjectBytesSource } from './objects.js';

const TENANT = '018f0000-0000-7000-8000-000000000001';
const OTHER = '018f0000-0000-7000-8000-000000000002';

function sourceOf(bodies: Record<string, string>) {
  const reads: string[] = [];
  const source: ObjectBytesSource = {
    getBytes: (_bucket, key) => {
      reads.push(key);
      const body = bodies[key];
      if (body === undefined) return Promise.reject(new Error('NoSuchKey'));
      return Promise.resolve(new TextEncoder().encode(body));
    },
  };
  return { source, reads };
}

describe('createObjectReader', () => {
  it('hashes the bytes stored under the tenant prefix', async () => {
    const key = `${TENANT}/run-1/000001`;
    const { source } = sourceOf({ [key]: 'body' });
    const reader = createObjectReader({ source, bucket: 'evidence', tenantId: TENANT });
    expect(await reader.sha256Of(key)).toBe(sha256Hex('body'));
  });

  it('refuses another tenant prefix before any read', async () => {
    const { source, reads } = sourceOf({ [`${OTHER}/run-1/000001`]: 'secret' });
    const reader = createObjectReader({ source, bucket: 'evidence', tenantId: TENANT });
    await expect(reader.sha256Of(`${OTHER}/run-1/000001`)).rejects.toThrow(ValidationError);
    expect(reads).toEqual([]);
  });

  it('refuses a key that only looks like the tenant prefix', async () => {
    const { source, reads } = sourceOf({});
    const reader = createObjectReader({ source, bucket: 'evidence', tenantId: TENANT });
    await expect(reader.sha256Of(`${TENANT}x/run-1/000001`)).rejects.toThrow(ValidationError);
    expect(reads).toEqual([]);
  });

  it('lets a missing object reject, so the binding can fail closed', async () => {
    const { source } = sourceOf({});
    const reader = createObjectReader({ source, bucket: 'evidence', tenantId: TENANT });
    await expect(reader.sha256Of(`${TENANT}/run-1/000009`)).rejects.toThrow('NoSuchKey');
  });
});

describe('s3ObjectBytesSource', () => {
  it('reads the body of a GetObject response as bytes', async () => {
    const client = {
      send: (command: { input: { Bucket: string; Key: string } }) => {
        expect(command.input).toEqual({ Bucket: 'evidence', Key: 'k' });
        return Promise.resolve({
          Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([104, 105])) },
        });
      },
    };
    const source = s3ObjectBytesSource(client);
    expect(Array.from(await source.getBytes('evidence', 'k'))).toEqual([104, 105]);
  });

  it('refuses a response without a body', async () => {
    const source = s3ObjectBytesSource({ send: () => Promise.resolve({}) });
    await expect(source.getBytes('evidence', 'k')).rejects.toThrow('no body');
  });
});
