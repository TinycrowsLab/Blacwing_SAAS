import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { EvidenceImmutableError } from './errors.js';
import { createEvidenceStore, type EvidenceStoreConfig, type TenantKeyGate } from './store.js';

import type { EvidenceStoreMetrics } from './telemetry.js';

const TENANT = '018f0000-0000-7000-8000-000000000001';
const OTHER = '018f0000-0000-7000-8000-000000000002';
const RUN = '018f0000-0000-7000-8000-0000000000aa';
const OBJECT_ID = '018f0000-0000-7000-8000-0000000000bb';
const NOW = new Date('2026-10-31T00:00:00.000Z');
const DAY_MS = 86_400_000;
const CONFIG: EvidenceStoreConfig = {
  bucket: 'bw-test-evidence',
  objectLockMode: 'COMPLIANCE',
  defaultRetentionDays: 365,
  sse: 'aws:kms',
  kmsKeyId: 'bw-evidence-key',
};

interface StoredHead {
  readonly versionId: string;
  readonly bytes: Uint8Array;
  readonly metadata: Record<string, string>;
  readonly retainUntil?: Date | undefined;
  readonly legalHold?: boolean;
}

/** A fake S3 client that records every command and answers the calls the store makes. */
function fakeS3(
  options: {
    lockConfigured?: boolean;
    lockMissingError?: boolean;
    retentionMode?: string;
    heads?: Record<string, StoredHead>;
    wormOnDelete?: boolean;
  } = {},
) {
  const heads: Record<string, StoredHead> = { ...(options.heads ?? {}) };
  const sent: { command: unknown; input: Record<string, unknown> }[] = [];
  const respond = (command: object): unknown => {
    const input = (command as { input: Record<string, unknown> }).input;
    // The startup lock check is not a write or a read of an object, so it is not recorded as one.
    if (!(command instanceof GetObjectLockConfigurationCommand)) sent.push({ command, input });
    if (command instanceof GetObjectLockConfigurationCommand) {
      if (options.lockMissingError === true) {
        throw Object.assign(new Error('no lock'), { name: 'ObjectLockConfigurationNotFoundError' });
      }
      return {
        ObjectLockConfiguration: {
          ObjectLockEnabled: options.lockConfigured === false ? undefined : 'Enabled',
        },
      };
    }
    if (command instanceof PutObjectCommand) {
      const key = input.Key as string;
      heads[key] = {
        versionId: 'v-1',
        bytes: input.Body as Uint8Array,
        metadata: (input.Metadata as Record<string, string> | undefined) ?? {},
        retainUntil: input.ObjectLockRetainUntilDate as Date,
        legalHold: input.ObjectLockLegalHoldStatus === 'ON',
      };
      return { VersionId: 'v-1' };
    }
    if (command instanceof HeadObjectCommand) {
      const head = heads[input.Key as string];
      if (head === undefined) {
        throw Object.assign(new Error('not found'), {
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        });
      }
      return {
        VersionId: head.versionId,
        ContentLength: head.bytes.byteLength,
        Metadata: head.metadata,
        ObjectLockRetainUntilDate: head.retainUntil,
        ObjectLockLegalHoldStatus: head.legalHold === true ? 'ON' : 'OFF',
      };
    }
    if (command instanceof GetObjectRetentionCommand) {
      const retainUntil = heads[input.Key as string]?.retainUntil;
      return {
        Retention: { Mode: options.retentionMode ?? 'COMPLIANCE', RetainUntilDate: retainUntil },
      };
    }
    if (command instanceof GetObjectCommand) {
      const head = heads[input.Key as string];
      if (head === undefined) throw Object.assign(new Error('gone'), { name: 'NoSuchKey' });
      return { Body: Readable.from([head.bytes]) };
    }
    if (command instanceof DeleteObjectCommand) {
      if (options.wormOnDelete === true)
        throw new Error('Object is WORM protected and cannot be overwritten');
      return {};
    }
    throw new Error(`unexpected S3 command ${command.constructor.name}`);
  };
  const client = {
    config: {},
    send: (command: object) =>
      new Promise((resolve) => {
        resolve(respond(command));
      }),
  } as unknown as S3Client;
  return { client, sent, heads };
}

function gate(reject?: Error): TenantKeyGate & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ensureTenantKek(tenantId) {
      calls.push(tenantId);
      return reject === undefined ? Promise.resolve({ created: false }) : Promise.reject(reject);
    },
  };
}

async function storeWith(
  s3: ReturnType<typeof fakeS3>,
  overrides: Partial<{
    keys: TenantKeyGate;
    metrics: EvidenceStoreMetrics;
    newObjectId: () => string;
  }> = {},
) {
  return createEvidenceStore({
    client: s3.client,
    config: CONFIG,
    keys: overrides.keys ?? gate(),
    now: () => NOW,
    newObjectId: overrides.newObjectId ?? (() => OBJECT_ID),
    ...(overrides.metrics === undefined ? {} : { metrics: overrides.metrics }),
  });
}

async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('createEvidenceStore: the startup Object Lock check (fail closed)', () => {
  it('starts when the bucket has Object Lock enabled', async () => {
    await expect(storeWith(fakeS3())).resolves.toBeDefined();
  });

  it('refuses to start when the bucket has no Object Lock', async () => {
    const s3 = fakeS3({ lockConfigured: false });
    const error = await refusalOf(storeWith(s3));
    expect(error).toMatchObject({ code: 'INTERNAL' });
    expect(s3.sent.some((s) => s.command instanceof PutObjectCommand)).toBe(false);
  });

  it('refuses to start when the lock configuration is absent altogether', async () => {
    await expect(storeWith(fakeS3({ lockMissingError: true }))).rejects.toThrow(
      /refusing to start/,
    );
  });
});

describe('put: fail closed before any write', () => {
  it('writes nothing when the tenant key gate is down (OpenBao unreachable or tenant disabled)', async () => {
    const s3 = fakeS3();
    const store = await storeWith(s3, { keys: gate(new Error('openbao unreachable')) });
    await expect(
      store.put(TENANT, { runId: RUN, kind: 'trace' }, new Uint8Array([1]), {
        contentType: 'text/plain',
      }),
    ).rejects.toThrow('openbao unreachable');
    expect(s3.sent.some((s) => s.command instanceof PutObjectCommand)).toBe(false);
  });
});

describe('put: input validation', () => {
  const valid = { contentType: 'text/plain' };
  it.each([
    ['a non-UUID tenant', 'tenant-a', { runId: RUN, kind: 'trace' }],
    ['an uppercase tenant', TENANT.toUpperCase(), { runId: RUN, kind: 'trace' }],
    ['a non-UUID run', TENANT, { runId: 'run-1', kind: 'trace' }],
    ['a kind with a slash', TENANT, { runId: RUN, kind: 'a/b' }],
    ['a kind starting with a digit', TENANT, { runId: RUN, kind: '1trace' }],
    ['a kind with traversal', TENANT, { runId: RUN, kind: '../x' }],
  ] as const)('refuses %s with no S3 call', async (_label, tenantId, key) => {
    const s3 = fakeS3();
    const store = await storeWith(s3);
    await expect(store.put(tenantId, key, new Uint8Array([1]), valid)).rejects.toThrow(
      ValidationError,
    );
    expect(s3.sent).toEqual([]);
  });

  it('refuses an empty or missing content type and an invalid retention date', async () => {
    const store = await storeWith(fakeS3());
    await expect(
      store.put(TENANT, { runId: RUN, kind: 'trace' }, new Uint8Array([1]), { contentType: '' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      store.put(TENANT, { runId: RUN, kind: 'trace' }, new Uint8Array([1]), {
        contentType: 'text/plain',
        retentionUntil: new Date('not a date'),
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('reads: a key outside the tenant is refused before any S3 call (§8.6)', () => {
  const foreign = `t/${OTHER}/runs/${RUN}/trace/${OBJECT_ID}`;
  const lookalike = `t/${TENANT}x/runs/${RUN}/trace/${OBJECT_ID}`;
  const traversal = `t/${TENANT}/runs/../../${OTHER}/runs/${RUN}/trace/${OBJECT_ID}`;

  it.each([foreign, lookalike, traversal, `t/${TENANT}/${OBJECT_ID}`, `tenants/${TENANT}/runs/x`])(
    'refuses %s on getStream, headObject and delete',
    async (objectKey) => {
      const s3 = fakeS3({
        heads: { [objectKey]: { versionId: 'v', bytes: new Uint8Array(), metadata: {} } },
      });
      const store = await storeWith(s3);
      await expect(store.getStream(TENANT, objectKey)).rejects.toThrow(ValidationError);
      await expect(store.headObject(TENANT, objectKey)).rejects.toThrow(ValidationError);
      await expect(store.delete(TENANT, objectKey)).rejects.toThrow(ValidationError);
      expect(s3.sent).toEqual([]);
    },
  );

  it('refuses a tenant id that is not a UUID before reading the key', async () => {
    const s3 = fakeS3();
    const store = await storeWith(s3);
    await expect(
      store.headObject('tenant-a', `t/tenant-a/runs/${RUN}/trace/${OBJECT_ID}`),
    ).rejects.toThrow(ValidationError);
    expect(s3.sent).toEqual([]);
  });
});

describe('headObject and getStream', () => {
  const key = `t/${TENANT}/runs/${RUN}/trace/${OBJECT_ID}`;

  it('returns the stored sha256, size and retention for an integrity check', async () => {
    const retainUntil = new Date(NOW.getTime() + 365 * DAY_MS);
    const store = await storeWith(
      fakeS3({
        heads: {
          [key]: {
            versionId: 'v-9',
            bytes: new Uint8Array([1, 2, 3]),
            metadata: { sha256: 'a'.repeat(64) },
            retainUntil,
            legalHold: false,
          },
        },
      }),
    );
    expect(await store.headObject(TENANT, key)).toEqual({
      objectKey: key,
      versionId: 'v-9',
      sha256: 'a'.repeat(64),
      size: 3,
      retainUntil,
      legalHold: false,
    });
  });

  it('returns undefined for an absent object', async () => {
    expect(await (await storeWith(fakeS3())).headObject(TENANT, key)).toBeUndefined();
  });

  it('fails closed with a generic error when a stored object has no digest', async () => {
    const store = await storeWith(
      fakeS3({ heads: { [key]: { versionId: 'v', bytes: new Uint8Array([1]), metadata: {} } } }),
    );
    expect(await refusalOf(store.headObject(TENANT, key))).toMatchObject({ code: 'INTERNAL' });
  });

  it('streams the bytes back and maps a missing object to NotFound', async () => {
    const store = await storeWith(
      fakeS3({
        heads: {
          [key]: { versionId: 'v', bytes: new TextEncoder().encode('evidence'), metadata: {} },
        },
      }),
    );
    const stream = await store.getStream(TENANT, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('evidence');
    await expect(
      store.getStream(TENANT, `t/${TENANT}/runs/${RUN}/trace/${RUN}`),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('delete: never removes an object that is still locked', () => {
  const key = `t/${TENANT}/runs/${RUN}/trace/${OBJECT_ID}`;
  const headed = (
    retainUntil: Date | undefined,
    legalHold = false,
  ): Record<string, StoredHead> => ({
    [key]: {
      versionId: 'v-3',
      bytes: new Uint8Array([1]),
      metadata: { sha256: 'b'.repeat(64) },
      retainUntil,
      legalHold,
    },
  });

  it('refuses while the retention runs', async () => {
    const s3 = fakeS3({ heads: headed(new Date(NOW.getTime() + DAY_MS)) });
    const error = await refusalOf((await storeWith(s3)).delete(TENANT, key));
    expect(error).toBeInstanceOf(EvidenceImmutableError);
    expect(s3.sent.some((s) => s.command instanceof DeleteObjectCommand)).toBe(false);
  });

  it('refuses while a legal hold is on, even after the retention has passed', async () => {
    const s3 = fakeS3({ heads: headed(new Date(NOW.getTime() - DAY_MS), true) });
    await expect((await storeWith(s3)).delete(TENANT, key)).rejects.toThrow(EvidenceImmutableError);
    expect(s3.sent.some((s) => s.command instanceof DeleteObjectCommand)).toBe(false);
  });

  it('refuses a version with no retain-until (fail closed)', async () => {
    const s3 = fakeS3({ heads: headed(undefined) });
    await expect((await storeWith(s3)).delete(TENANT, key)).rejects.toThrow(EvidenceImmutableError);
  });

  it('deletes the exact version once the retention has ended and no hold is on', async () => {
    const s3 = fakeS3({ heads: headed(new Date(NOW.getTime() - DAY_MS)) });
    await (await storeWith(s3)).delete(TENANT, key);
    const del = s3.sent.find((s) => s.command instanceof DeleteObjectCommand)?.input ?? {};
    expect(del).toMatchObject({ Bucket: CONFIG.bucket, Key: key, VersionId: 'v-3' });
  });

  it('maps S3 WORM refusal to EvidenceImmutableError', async () => {
    const s3 = fakeS3({ heads: headed(new Date(NOW.getTime() - DAY_MS)), wormOnDelete: true });
    await expect((await storeWith(s3)).delete(TENANT, key)).rejects.toThrow(EvidenceImmutableError);
  });

  it('reports a missing object as NotFound, not as a lock', async () => {
    await expect((await storeWith(fakeS3())).delete(TENANT, key)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
