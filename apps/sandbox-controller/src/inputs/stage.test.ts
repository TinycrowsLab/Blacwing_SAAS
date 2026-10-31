import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AppError, ValidationError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { createControllerMetrics } from '../metrics.js';
import {
  SbxInputIntegrityFailedError,
  SbxInputTooLargeError,
  SbxSourceAuthFailedError,
  SbxSourceSymlinkEscapeError,
} from './errors.js';
import {
  stageRunInputs,
  teardownRunInputs,
  type InputAuditEvent,
  type RunInputStagerDeps,
} from './stage.js';
import { forceRemove } from './tree.js';

import type { GitCheckoutRequest, GitCloner } from './git.js';
import type { InputObjectStore } from './object-store.js';

const TENANT = '01930000-0000-7000-8000-00000000000a';
const OTHER_TENANT = '01930000-0000-7000-8000-00000000000b';
const RUN = '01930000-0000-7000-8000-0000000000a1';
const MANIFEST = '01930000-0000-7000-8000-0000000000c1';
const MIB = 1024 * 1024;
const TOKEN = 'ghp_deploy_token_must_not_leak_0123456789';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const spec = (key: string, bytes: Uint8Array) => ({
  kind: 'openapi',
  objectKey: key,
  sha256: sha(bytes),
  sizeBytes: bytes.byteLength,
});

interface Harness {
  readonly root: string;
  readonly stagingRoot: string;
  readonly objects: Map<string, Uint8Array>;
  readonly fetched: string[];
  readonly gitCalls: GitCheckoutRequest[];
  readonly audit: InputAuditEvent[];
  readonly logs: string[];
  manifest: unknown;
  git: GitCloner;
  deps: RunInputStagerDeps;
}

/** A git fake that writes a repo and leaves a token-bearing URL in `.git/config` (the stager must strip it). */
function fakeGit(
  harness: Pick<Harness, 'gitCalls'>,
  files: Record<string, string>,
  configText?: string,
): GitCloner {
  return {
    async checkout(request) {
      harness.gitCalls.push(request);
      for (const [name, text] of Object.entries(files)) {
        await mkdir(dirname(join(request.dest, name)), { recursive: true });
        await writeFile(join(request.dest, name), text);
      }
      await mkdir(join(request.dest, '.git'), { recursive: true });
      await writeFile(
        join(request.dest, '.git', 'config'),
        configText ??
          '[remote "origin"]\n\turl = https://x-access-token:leaked@example.com/acme/app.git\n',
      );
    },
  };
}

async function harnessWith(
  overrides: Partial<Pick<RunInputStagerDeps, 'git' | 'limits'>> = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'bw-stage-'));
  const logs: string[] = [];
  const logger = createLogger('sandbox-controller', {
    level: 'debug',
    nodeEnv: 'test',
    destination: { write: (line: string) => logs.push(line) },
  });
  const audit: InputAuditEvent[] = [];
  const harness: Harness = {
    root,
    stagingRoot: join(root, 'staging'),
    objects: new Map(),
    fetched: [],
    gitCalls: [],
    audit,
    logs,
    manifest: { specObjects: [], sourceRepo: null },
    git: fakeGit({ gitCalls: [] }, { 'README.md': 'hi' }),
    deps: undefined as unknown as RunInputStagerDeps,
  };
  const objects: InputObjectStore = {
    getBytes: (bucket, key) => {
      harness.fetched.push(`${bucket}/${key}`);
      return Promise.resolve(harness.objects.get(key) ?? null);
    },
  };
  harness.deps = {
    manifests: {
      load: (tenantId) => Promise.resolve(tenantId === TENANT ? harness.manifest : null),
    },
    objects,
    bucket: 'bw-inputs',
    git: overrides.git ?? harness.git,
    secrets: { resolve: () => Promise.resolve(TOKEN) },
    stagingRoot: harness.stagingRoot,
    limits: overrides.limits ?? { inputsMaxMib: 256, srcMaxMib: 1024 },
    audit: {
      emit: (event) => {
        audit.push(event);
        return Promise.resolve();
      },
    },
    metrics: createControllerMetrics('0.0.0', 'test'),
    logger,
  };
  return harness;
}

const request = { tenantId: TENANT, runId: RUN, manifestId: MANIFEST };
const runDir = (h: Harness, tenant = TENANT): string => join(h.stagingRoot, tenant, RUN);

describe('stageRunInputs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harnessWith();
  });
  afterEach(async () => {
    await forceRemove(h.root);
    await rm(h.root, { recursive: true, force: true });
  });

  it('stages verified spec objects under inputs/ as read-only files and reports the bytes', async () => {
    const bytes = new TextEncoder().encode('openapi: 3.1.0\n');
    const key = `${TENANT}/spec/openapi.yaml`;
    h.objects.set(key, bytes);
    h.manifest = { specObjects: [spec(key, bytes)] };

    const staged = await stageRunInputs(h.deps, request);

    expect(staged.srcDir).toBeNull();
    expect(staged.objectKeys).toEqual([key]);
    expect(staged.inputBytes).toBe(bytes.byteLength);
    expect(await readFile(join(staged.inputsDir, 'openapi.yaml'), 'utf8')).toBe('openapi: 3.1.0\n');
    expect((await stat(join(staged.inputsDir, 'openapi.yaml'))).mode & 0o222).toBe(0);
    expect((await stat(staged.inputsDir)).mode & 0o222).toBe(0);
    expect(h.audit.map((event) => event.type)).toEqual(['inputs.staged']);
  });

  it('keeps Unicode and spaced file names verbatim', async () => {
    const bytes = new TextEncoder().encode('{}');
    const key = `${TENANT}/spec/ünïcode 文件 v2.json`;
    h.objects.set(key, bytes);
    h.manifest = { specObjects: [spec(key, bytes)] };
    const staged = await stageRunInputs(h.deps, request);
    expect(await readdir(staged.inputsDir)).toEqual(['ünïcode 文件 v2.json']);
  });

  it('fails closed on a sha256 mismatch and leaves no staging dir behind', async () => {
    const key = `${TENANT}/spec/a.yaml`;
    h.objects.set(key, new TextEncoder().encode('tampered'));
    h.manifest = { specObjects: [{ ...spec(key, new TextEncoder().encode('original')) }] };
    await expect(stageRunInputs(h.deps, request)).rejects.toBeInstanceOf(
      SbxInputIntegrityFailedError,
    );
    await expect(stat(runDir(h))).rejects.toThrow();
  });

  it('fails closed when an object is missing from storage', async () => {
    const bytes = new TextEncoder().encode('x');
    h.manifest = { specObjects: [spec(`${TENANT}/spec/gone.yaml`, bytes)] };
    const error = await stageRunInputs(h.deps, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SbxInputIntegrityFailedError);
    expect((error as AppError).code).toBe('SBX_INPUT_INTEGRITY_FAILED');
    await expect(stat(runDir(h))).rejects.toThrow();
  });

  it('refuses a declared size that does not match the stored bytes', async () => {
    const bytes = new TextEncoder().encode('abc');
    const key = `${TENANT}/spec/a.yaml`;
    h.objects.set(key, bytes);
    h.manifest = { specObjects: [{ ...spec(key, bytes), sizeBytes: 99 }] };
    await expect(stageRunInputs(h.deps, request)).rejects.toBeInstanceOf(
      SbxInputIntegrityFailedError,
    );
  });

  it('rejects oversize inputs before any download, with SBX_INPUT_TOO_LARGE', async () => {
    h = await harnessWith({ limits: { inputsMaxMib: 1, srcMaxMib: 1024 } });
    const key = `${TENANT}/spec/big.bin`;
    const declared = 2 * MIB;
    h.manifest = {
      specObjects: [{ kind: 'har', objectKey: key, sha256: 'a'.repeat(64), sizeBytes: declared }],
    };
    const error = await stageRunInputs(h.deps, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SbxInputTooLargeError);
    expect((error as AppError).code).toBe('SBX_INPUT_TOO_LARGE');
    expect(h.fetched).toEqual([]);
  });

  it('refuses an object of another tenant (tenant prefix, §8.6) before reading it', async () => {
    h.manifest = {
      specObjects: [
        {
          kind: 'openapi',
          objectKey: `${OTHER_TENANT}/spec/a.yaml`,
          sha256: 'a'.repeat(64),
          sizeBytes: 1,
        },
      ],
    };
    await expect(stageRunInputs(h.deps, request)).rejects.toBeInstanceOf(ValidationError);
    expect(h.fetched).toEqual([]);
  });

  it('refuses object names that could escape the inputs directory', async () => {
    const bytes = new TextEncoder().encode('x');
    const key = `${TENANT}/spec/..`;
    h.objects.set(key, bytes);
    h.manifest = { specObjects: [spec(key, bytes)] };
    await expect(stageRunInputs(h.deps, request)).rejects.toBeInstanceOf(
      SbxInputIntegrityFailedError,
    );
  });

  it('refuses two spec objects that would share a file name', async () => {
    const bytes = new TextEncoder().encode('x');
    h.objects.set(`${TENANT}/a/spec.yaml`, bytes);
    h.objects.set(`${TENANT}/b/spec.yaml`, bytes);
    h.manifest = {
      specObjects: [spec(`${TENANT}/a/spec.yaml`, bytes), spec(`${TENANT}/b/spec.yaml`, bytes)],
    };
    await expect(stageRunInputs(h.deps, request)).rejects.toBeInstanceOf(
      SbxInputIntegrityFailedError,
    );
  });

  it('rejects an unknown manifest in this tenant (reads as absent)', async () => {
    await expect(
      stageRunInputs(h.deps, { ...request, tenantId: OTHER_TENANT }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('checks out the source with the deploy token resolved for the controller only, and never stores it', async () => {
    h = await harnessWith({ git: fakeGit({ gitCalls: [] }, { 'src/app.ts': 'export {};' }) });
    h.manifest = {
      specObjects: [],
      sourceRepo: {
        url: 'https://example.com/acme/app.git',
        ref: 'main',
        deployKeyRef: 'secret://deploy',
      },
    };
    const gitCalls: GitCheckoutRequest[] = [];
    h.deps = { ...h.deps, git: fakeGit({ gitCalls }, { 'src/app.ts': 'export {};' }) };

    const staged = await stageRunInputs(h.deps, request);

    expect(staged.srcDir).toBe(join(runDir(h), 'src'));
    expect(gitCalls[0]?.bearerToken).toBe(TOKEN);
    expect(gitCalls[0]?.url).toBe('https://example.com/acme/app.git');
    const config = await readFile(join(staged.srcDir ?? '', '.git', 'config'), 'utf8');
    expect(config).not.toContain('leaked');
    expect(config).not.toContain('@');
    const everything = JSON.stringify(h.audit) + h.logs.join('\n') + JSON.stringify(staged);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('leaked');
    expect(h.audit.find((event) => event.type === 'source.checked_out')).toMatchObject({
      repoUrl: 'https://example.com/acme/app.git',
      ref: 'main',
    });
  });

  it('refuses repository URLs that are not https or that carry userinfo', async () => {
    for (const url of [
      'http://example.com/a.git',
      'https://user:pw@example.com/a.git',
      'file:///etc/passwd',
      'not a url',
    ]) {
      h.manifest = { specObjects: [], sourceRepo: { url } };
      await expect(stageRunInputs(h.deps, request)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('refuses a ref that could be read as a git option', async () => {
    h.manifest = {
      specObjects: [],
      sourceRepo: { url: 'https://example.com/a.git', ref: '--upload-pack=evil' },
    };
    await expect(stageRunInputs(h.deps, request)).rejects.toThrow();
  });

  it('refuses a deploy key without a repository url', async () => {
    h.manifest = { specObjects: [], sourceRepo: { deployKeyRef: 'secret://deploy' } };
    await expect(stageRunInputs(h.deps, request)).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses an oversize source with SBX_INPUT_TOO_LARGE and removes the checkout', async () => {
    h = await harnessWith({ limits: { inputsMaxMib: 256, srcMaxMib: 1 } });
    h.manifest = { specObjects: [], sourceRepo: { url: 'https://example.com/a.git' } };
    h.deps = { ...h.deps, git: fakeGit({ gitCalls: [] }, { 'blob.bin': 'x'.repeat(2 * MIB) }) };
    await expect(stageRunInputs(h.deps, request)).rejects.toBeInstanceOf(SbxInputTooLargeError);
    await expect(stat(runDir(h))).rejects.toThrow();
  });

  it('refuses a symlink in the checkout that points outside /src', async () => {
    h = await harnessWith();
    h.manifest = { specObjects: [], sourceRepo: { url: 'https://example.com/a.git' } };
    const escaping: GitCloner = {
      async checkout(req) {
        await writeFile(join(req.dest, 'real.txt'), 'ok');
        await symlink('/etc/hostname', join(req.dest, 'leak'));
      },
    };
    h.deps = { ...h.deps, git: escaping };
    await expect(stageRunInputs(h.deps, request)).rejects.toBeInstanceOf(
      SbxSourceSymlinkEscapeError,
    );
    await expect(stat(runDir(h))).rejects.toThrow();
  });

  it('surfaces SBX_SOURCE_AUTH_FAILED and leaves no partial checkout', async () => {
    h = await harnessWith();
    h.manifest = {
      specObjects: [],
      sourceRepo: { url: 'https://example.com/a.git', deployKeyRef: 'secret://deploy' },
    };
    const refusing: GitCloner = {
      async checkout(req) {
        await writeFile(join(req.dest, 'partial.txt'), 'half');
        throw new SbxSourceAuthFailedError();
      },
    };
    h.deps = { ...h.deps, git: refusing };
    const error = await stageRunInputs(h.deps, request).catch((e: unknown) => e);
    expect((error as AppError).code).toBe('SBX_SOURCE_AUTH_FAILED');
    await expect(stat(runDir(h))).rejects.toThrow();
  });

  it('cleans the staging dir when the checkout is interrupted mid-way', async () => {
    h = await harnessWith();
    h.manifest = { specObjects: [], sourceRepo: { url: 'https://example.com/a.git' } };
    const killed: GitCloner = {
      async checkout(req) {
        await writeFile(join(req.dest, 'partial.txt'), 'half');
        throw new Error('signal: SIGKILL');
      },
    };
    h.deps = { ...h.deps, git: killed };
    await expect(stageRunInputs(h.deps, request)).rejects.toThrow('SIGKILL');
    await expect(stat(runDir(h))).rejects.toThrow();
  });

  it('teardown removes a run and is idempotent', async () => {
    const bytes = new TextEncoder().encode('x');
    const key = `${TENANT}/spec/a.yaml`;
    h.objects.set(key, bytes);
    h.manifest = { specObjects: [spec(key, bytes)] };
    await stageRunInputs(h.deps, request);
    await teardownRunInputs(h.stagingRoot, { tenantId: TENANT, runId: RUN });
    await expect(stat(runDir(h))).rejects.toThrow();
    await expect(
      teardownRunInputs(h.stagingRoot, { tenantId: TENANT, runId: RUN }),
    ).resolves.toBeUndefined();
  });
});
