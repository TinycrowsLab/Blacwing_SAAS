import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { z } from 'zod';

import { uuidV7Schema } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import { SbxInputIntegrityFailedError, SbxInputTooLargeError } from './errors.js';
import { stripGitConfigCredentials, type GitCloner } from './git.js';
import {
  assertNoEscapingSymlinks,
  forceRemove,
  makeFreshDir,
  makeReadOnly,
  treeBytes,
} from './tree.js';

import type { ControllerMetrics } from '../metrics.js';
import type { InputObjectStore } from './object-store.js';
import type { Logger } from '@blackwing/logger';

const MIB = 1_048_576;
const SHA256_HEX_LENGTH = 64;
const SHA256_HEX = new RegExp(`^[a-f0-9]{${String(SHA256_HEX_LENGTH)}}$`);
const MAX_OBJECT_KEY = 1024;
const MAX_KIND = 64;
const MAX_REPO_URL = 2048;
const MAX_SECRET_REF = 512;
const MAX_SPARSE_PATH = 1024;
/** Branch, tag or commit. No leading dash (option injection), no spaces, no `..`. */
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MAX_SPEC_OBJECTS = 256;
const MAX_SPARSE_PATHS = 256;
const MAX_NAME_LENGTH = 255;

const specObjectSchema = z.object({
  kind: z.string().min(1).max(MAX_KIND),
  objectKey: z.string().min(1).max(MAX_OBJECT_KEY),
  sha256: z.string().regex(SHA256_HEX, 'must be a lowercase sha256 hex digest'),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const sourceRepoSchema = z.object({
  url: z.string().max(MAX_REPO_URL).optional(),
  ref: z.string().regex(GIT_REF, 'must be a branch, tag or commit').optional(),
  /** Secret reference of the deploy token. Resolved by the controller only (§8.7). */
  deployKeyRef: z.string().min(1).max(MAX_SECRET_REF).optional(),
  /** Manifest paths for a sparse checkout (cone-free patterns, relative, no `..`). */
  paths: z.array(z.string().min(1).max(MAX_SPARSE_PATH)).max(MAX_SPARSE_PATHS).optional(),
});

const manifestSchema = z.object({
  specObjects: z.array(specObjectSchema).max(MAX_SPEC_OBJECTS).default([]),
  sourceRepo: sourceRepoSchema.nullable().optional(),
});

export type InputManifest = z.infer<typeof manifestSchema>;

/** The input manifest of a run, read through the tenant's data path (the composition root wires it, §8.6). */
export interface ManifestSource {
  load(tenantId: string, manifestId: string): Promise<unknown>;
}

/** Resolves a deploy-token reference to its plaintext for the controller's own git call. Never returned to a caller. */
export interface DeployTokenResolver {
  resolve(tenantId: string, deployKeyRef: string): Promise<string>;
}

export interface InputAuditEvent {
  readonly type: 'inputs.staged' | 'source.checked_out';
  readonly tenantId: string;
  readonly runId: string;
  readonly manifestId: string;
  /** Object keys (`inputs.staged`) or the credential-free repo URL and ref (`source.checked_out`). Never a token. */
  readonly objectKeys?: readonly string[];
  readonly repoUrl?: string;
  readonly ref?: string;
  readonly bytes: number;
  readonly occurredAt: string;
}

export interface InputAuditEmitter {
  emit(event: InputAuditEvent): Promise<void>;
}

/** Default emitter: one structured `audit` log line per event (the ledger lands behind #82). */
export function createInputLogAuditEmitter(logger: Logger): InputAuditEmitter {
  const log = logger.child({ component: 'audit' });
  return {
    emit(event) {
      log.info({ audit: event }, event.type);
      return Promise.resolve();
    },
  };
}

export interface RunInputStagerDeps {
  readonly manifests: ManifestSource;
  readonly objects: InputObjectStore;
  readonly bucket: string;
  readonly git: GitCloner;
  readonly secrets: DeployTokenResolver;
  /** Controller-local root; each run stages under `<root>/<tenant>/<run>`. */
  readonly stagingRoot: string;
  readonly limits: { readonly inputsMaxMib: number; readonly srcMaxMib: number };
  readonly audit: InputAuditEmitter;
  readonly metrics: Pick<ControllerMetrics, 'inputsStaged' | 'sourceBytes'>;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export interface StageRunInputsRequest {
  readonly tenantId: string;
  readonly runId: string;
  readonly manifestId: string;
}

/** Where a run's staged inputs live on the controller. Mount `inputsDir` at `/inputs`, `srcDir` at `/src`. */
export interface StagedRunInputs {
  readonly inputsDir: string;
  readonly srcDir: string | null;
  readonly inputBytes: number;
  readonly sourceBytes: number;
  readonly objectKeys: readonly string[];
}

/** Basename of a spec object, kept verbatim (Unicode included). Anything that could escape the directory is refused. */
function fileNameFor(objectKey: string): string {
  const name = posix.basename(objectKey);
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.length > MAX_NAME_LENGTH ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.includes('/')
  ) {
    throw new SbxInputIntegrityFailedError('spec object name is not a safe file name');
  }
  return name;
}

/** Only `https:` remotes with no userinfo, so a credential can never be in the URL the stager hands to git. */
function checkedRepoUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError('source repository url is not a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new ValidationError('source repository url must be https without credentials');
  }
  return parsed.toString();
}

function checkedSparsePaths(paths: readonly string[]): readonly string[] {
  for (const path of paths) {
    if (path.startsWith('/') || path.startsWith('-') || path.split('/').includes('..')) {
      throw new ValidationError(
        'source path must be relative and must not start with "-" or contain ".."',
      );
    }
  }
  return paths;
}

function sumOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

/**
 * Stages one run's inputs: spec objects into `inputs/` (sha256 and size verified against the manifest) and the
 * source checkout into `src/`. Every failure removes the run's staging dir, so a run never sees a partial mount.
 * Staged trees are made read-only before they are returned.
 */
export async function stageRunInputs(
  deps: RunInputStagerDeps,
  request: StageRunInputsRequest,
): Promise<StagedRunInputs> {
  const ids = z
    .object({ tenantId: uuidV7Schema, runId: uuidV7Schema, manifestId: uuidV7Schema })
    .parse(request);
  const log = deps.logger.child({
    component: 'input-stager',
    tenantId: ids.tenantId,
    runId: ids.runId,
  });
  const inputsMaxBytes = deps.limits.inputsMaxMib * MIB;
  const srcMaxBytes = deps.limits.srcMaxMib * MIB;

  const raw = await deps.manifests.load(ids.tenantId, ids.manifestId);
  if (raw === null) throw new ValidationError('input manifest not found in this tenant');
  const manifest = manifestSchema.parse(raw);

  for (const object of manifest.specObjects) {
    if (!object.objectKey.startsWith(`${ids.tenantId}/`)) {
      throw new ValidationError('spec object is outside this tenant');
    }
  }
  const named = manifest.specObjects.map((object) => ({
    object,
    name: fileNameFor(object.objectKey),
  }));
  if (new Set(named.map((entry) => entry.name)).size !== named.length) {
    throw new SbxInputIntegrityFailedError('two spec objects share a file name');
  }
  if (sumOf(manifest.specObjects.map((object) => object.sizeBytes)) > inputsMaxBytes) {
    throw new SbxInputTooLargeError(`run inputs exceed ${String(deps.limits.inputsMaxMib)} MiB`);
  }
  const source = manifest.sourceRepo ?? null;
  const repoUrl = source?.url === undefined ? null : checkedRepoUrl(source.url);
  const sparsePaths = source?.paths === undefined ? undefined : checkedSparsePaths(source.paths);
  if (source?.url === undefined && source?.deployKeyRef !== undefined) {
    throw new ValidationError('a deploy key reference needs a source repository url');
  }

  const runDir = join(deps.stagingRoot, ids.tenantId, ids.runId);
  const inputsDir = join(runDir, 'inputs');
  const srcDir = join(runDir, 'src');
  await forceRemove(runDir);
  await makeFreshDir(inputsDir);
  try {
    const objectKeys: string[] = [];
    const inputSizes: number[] = [];
    for (const { object, name } of named) {
      const bytes = await deps.objects.getBytes(deps.bucket, object.objectKey);
      if (bytes === null) {
        throw new SbxInputIntegrityFailedError(`spec object is missing: ${object.objectKey}`);
      }
      if (bytes.byteLength !== object.sizeBytes) {
        throw new SbxInputIntegrityFailedError(
          `spec object size does not match manifest: ${object.objectKey}`,
        );
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== object.sha256) {
        throw new SbxInputIntegrityFailedError(
          `spec object sha256 does not match manifest: ${object.objectKey}`,
        );
      }
      inputSizes.push(bytes.byteLength);
      await writeFile(join(inputsDir, name), bytes, { flag: 'wx', mode: 0o444 });
      objectKeys.push(object.objectKey);
    }
    const inputBytes = sumOf(inputSizes);

    let sourceBytes = 0;
    if (repoUrl !== null && source !== null) {
      const bearerToken =
        source.deployKeyRef === undefined
          ? undefined
          : await deps.secrets.resolve(ids.tenantId, source.deployKeyRef);
      await makeFreshDir(srcDir);
      await deps.git.checkout({
        url: repoUrl,
        ref: source.ref ?? 'HEAD',
        dest: srcDir,
        ...(bearerToken !== undefined ? { bearerToken } : {}),
        ...(sparsePaths !== undefined ? { sparsePaths } : {}),
      });
      await stripGitConfigCredentials(join(srcDir, '.git', 'config'));
      await assertNoEscapingSymlinks(srcDir);
      sourceBytes = await treeBytes(srcDir);
      if (sourceBytes > srcMaxBytes) {
        throw new SbxInputTooLargeError(
          `source checkout exceeds ${String(deps.limits.srcMaxMib)} MiB`,
        );
      }
      deps.metrics.sourceBytes.inc(sourceBytes);
    }

    await makeReadOnly(runDir);
    const occurredAt = (deps.now ?? (() => new Date()))().toISOString();
    await deps.audit.emit({
      type: 'inputs.staged',
      tenantId: ids.tenantId,
      runId: ids.runId,
      manifestId: ids.manifestId,
      objectKeys,
      bytes: inputBytes,
      occurredAt,
    });
    if (repoUrl !== null && source !== null) {
      await deps.audit.emit({
        type: 'source.checked_out',
        tenantId: ids.tenantId,
        runId: ids.runId,
        manifestId: ids.manifestId,
        repoUrl,
        ref: source.ref ?? 'HEAD',
        bytes: sourceBytes,
        occurredAt,
      });
    }
    deps.metrics.inputsStaged.labels({ result: 'staged' }).inc();
    log.info({ objectKeys, inputBytes, sourceBytes }, 'run inputs staged');
    return {
      inputsDir,
      srcDir: repoUrl === null ? null : srcDir,
      inputBytes,
      sourceBytes,
      objectKeys,
    };
  } catch (error) {
    deps.metrics.inputsStaged.labels({ result: 'failed' }).inc();
    await forceRemove(runDir).catch((cleanupError: unknown) => {
      log.error({ err: cleanupError }, 'input staging cleanup failed');
    });
    throw error;
  }
}

/** Removes a run's staged inputs on teardown. Idempotent. */
export async function teardownRunInputs(
  stagingRoot: string,
  scope: { readonly tenantId: string; readonly runId: string },
): Promise<void> {
  await forceRemove(join(stagingRoot, scope.tenantId, scope.runId));
}
