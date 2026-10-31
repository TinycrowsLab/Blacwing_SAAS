import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';
import { type MinioHandle, withMinio } from '@blackwing/testing/containers';
import { surfaceContainerLogsOnFailure } from '@blackwing/testing/vitest';

import { createControllerMetrics } from '../metrics.js';
import { SbxInputIntegrityFailedError } from './errors.js';
import { shellGitCloner } from './git.js';
import { s3InputObjectStore } from './object-store.js';
import { stageRunInputs, type RunInputStagerDeps } from './stage.js';
import { forceRemove } from './tree.js';

/**
 * Integration against real object storage (MinIO, Testcontainers): spec objects are fetched by key, verified
 * by sha256 against the manifest, and staged read-only. Git is the real binary with a credential-free remote.
 */
const TENANT = '01930000-0000-7000-8000-00000000000a';
const RUN = '01930000-0000-7000-8000-0000000000a1';
const MANIFEST = '01930000-0000-7000-8000-0000000000c1';
const SPEC_KEY = `${TENANT}/specs/openapi.json`;
const SPEC = new TextEncoder().encode('{"openapi":"3.1.0","paths":{}}');

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

let minio: MinioHandle | undefined;
const handle = (): MinioHandle => {
  if (minio === undefined) throw new Error('withMinio did not start');
  return minio;
};

let root = '';
beforeAll(async () => {
  minio = await withMinio();
  root = await mkdtemp(join(tmpdir(), 'bw-stage-int-'));
  await handle().client.send(
    new PutObjectCommand({ Bucket: handle().bucket, Key: SPEC_KEY, Body: SPEC }),
  );
});
afterAll(async () => {
  await forceRemove(root);
  await minio?.stop();
});
surfaceContainerLogsOnFailure(() => [minio]);

let manifest: unknown = null;

function stager(stagingRoot: string): RunInputStagerDeps {
  return {
    manifests: { load: () => Promise.resolve(manifest) },
    objects: s3InputObjectStore(handle().client),
    bucket: handle().bucket,
    git: shellGitCloner(),
    secrets: {
      resolve: () => Promise.reject(new Error('no deploy token is referenced in this test')),
    },
    stagingRoot,
    limits: { inputsMaxMib: 256, srcMaxMib: 1024 },
    audit: { emit: () => Promise.resolve() },
    metrics: createControllerMetrics('0.0.0', 'test'),
    logger: createLogger('sandbox-controller', { level: 'silent', nodeEnv: 'test' }),
  };
}

const request = { tenantId: TENANT, runId: RUN, manifestId: MANIFEST };

describe('stageRunInputs against MinIO', () => {
  it('stages the spec object from MinIO read-only, with the sha256 the manifest declares', async () => {
    manifest = {
      specObjects: [
        { kind: 'openapi', objectKey: SPEC_KEY, sha256: sha(SPEC), sizeBytes: SPEC.byteLength },
      ],
      sourceRepo: null,
    };
    const stagingRoot = join(root, 'ok');
    const staged = await stageRunInputs(stager(stagingRoot), request);

    expect(staged.objectKeys).toEqual([SPEC_KEY]);
    const file = join(staged.inputsDir, 'openapi.json');
    expect(sha(await readFile(file))).toBe(sha(SPEC));
    expect((await stat(file)).mode & 0o222).toBe(0);
    expect((await stat(staged.inputsDir)).mode & 0o222).toBe(0);
    // A write attempt against the staged tree fails (read-only), not only the mode bits.
    await expect(writeFile(file, 'tampered')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(writeFile(join(staged.inputsDir, 'extra.json'), '{}')).rejects.toMatchObject({
      code: 'EACCES',
    });
    expect(sha(await readFile(file))).toBe(sha(SPEC));
  });

  it('fails closed when the stored bytes do not match the manifest sha256, leaving no stage behind', async () => {
    const tampered = new TextEncoder().encode('{"openapi":"3.1.0","paths":{"/admin":{}}}');
    const tamperedKey = `${TENANT}/specs/tampered.json`;
    await handle().client.send(
      new PutObjectCommand({ Bucket: handle().bucket, Key: tamperedKey, Body: tampered }),
    );
    manifest = {
      specObjects: [
        { kind: 'openapi', objectKey: tamperedKey, sha256: sha(SPEC), sizeBytes: SPEC.byteLength },
      ],
      sourceRepo: null,
    };
    const stagingRoot = join(root, 'tampered');
    await expect(stageRunInputs(stager(stagingRoot), request)).rejects.toBeInstanceOf(
      SbxInputIntegrityFailedError,
    );
    await expect(stat(join(stagingRoot, TENANT, RUN))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when the object is missing from storage', async () => {
    manifest = {
      specObjects: [
        {
          kind: 'openapi',
          objectKey: `${TENANT}/specs/absent.json`,
          sha256: sha(SPEC),
          sizeBytes: SPEC.byteLength,
        },
      ],
      sourceRepo: null,
    };
    await expect(stageRunInputs(stager(join(root, 'absent')), request)).rejects.toMatchObject({
      code: 'SBX_INPUT_INTEGRITY_FAILED',
    });
  });
});
