import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { trace } from '@opentelemetry/api';

import {
  PocHarnessManifestSchema,
  type HarnessStep,
  type PocHarnessManifest,
} from '@blackwing/contracts';
import {
  ConflictError,
  InternalError,
  isAppError,
  KillSwitchActiveError,
  redactBuiltinSecrets,
  ValidationError,
  type AppError,
} from '@blackwing/errors';

import { HARNESS_RUNNER_SOURCE } from './runner-source.js';

import type { RuntimeMetrics } from '../metrics.js';
import type { Logger } from '@blackwing/logger';

/**
 * Scaffolds the deterministic, offline-replayable PoC harness of one candidate into the sandbox tmpfs workspace
 * (EXPLOIT-002; CONTEXT_PACK §4.1, §8.7, §8.9). The layout is:
 *
 *   <workspace>/harness/<candidateId>/
 *     manifest.json            the validated PoC-harness manifest
 *     harness.json             the index: step files, their order, and the sha256 of each captured input
 *     steps/positive/NNN-<ref>.json        one declarative file per positive HarnessStep
 *     steps/negative_control/NNN-<ref>.json one per negative-control HarnessStep
 *     inputs/N.bin             captured evidence, copied by reference (binary-safe, never inlined)
 *     runner                   the stdlib Python runner that replays the index in order
 *
 * The candidate id namespaces the directory, so concurrent scaffolds in one session cannot collide.
 */

/** The index format the runner reads. Bump it with the runner. */
export const HARNESS_FORMAT_VERSION = 1;
/** Directory of the candidate-scoped harness inside a session workspace. */
const HARNESS_DIR = 'harness';

/** A captured evidence input the run resolved to a local file. */
interface HarnessInputSource {
  /** A local file the harness copies by reference. Its bytes are never read as text. */
  readonly path: string;
}

/** The scaffold's dependencies. Every one is required, so a missing audit, metric or log cannot be skipped silently. */
export interface HarnessScaffoldDeps {
  /** The session's tmpfs workspace, `/workspace/<sessionId>`. */
  readonly workspaceDir: string;
  /** Resolves an evidence ref to its local file; `null` when the run holds no such evidence. */
  readonly resolveInput: (ref: string) => Promise<HarnessInputSource | null>;
  /** The session's abort signal. Aborting it (kill switch, §8.5) stops the scaffold and removes the partial tree. */
  readonly signal?: AbortSignal;
  /** Writes `harness.scaffolded{candidateId}` to the audit ledger (through the broker). Called once, on success. */
  readonly audit: (event: HarnessScaffoldedEvent) => Promise<void>;
  readonly metrics: Pick<RuntimeMetrics, 'harnessScaffolded'>;
  readonly log: Logger;
  /** Seam for tests: fails a write with a chosen error. Production uses `fs/promises.writeFile`. */
  readonly io?: { readonly writeFile: typeof writeFile };
}

export interface HarnessScaffoldedEvent {
  readonly type: 'harness.scaffolded';
  readonly candidateId: string;
  readonly stepCount: number;
}

/** The files a scaffold wrote, relative to `root`. `verifyScaffold` checks the tree against this list. */
export interface HarnessLayout {
  /** Absolute path of `<workspace>/harness/<candidateId>`. */
  readonly root: string;
  /** Every file written, relative to `root`, in write order. */
  readonly files: readonly string[];
}

const COPY_CHUNK_BYTES = 65536;
const POSITIVE_PHASE = 'positive';
const NEGATIVE_PHASE = 'negative_control';
/** Width of the zero-padded step position in a step file name (`000-<ref>.json`). */
const POSITION_WIDTH = 3;
/** The runner executes `harness.json` and writes its observations; the runner file is executable. */
const RUNNER_MODE = 0o755;
const PRIVATE_FILE_MODE = 0o600;

interface IndexStep {
  readonly ref: string;
  readonly kind: HarnessStep['kind'];
  readonly file: string;
}
interface IndexInput {
  readonly ref: string;
  readonly file: string;
  readonly sha256: string;
}
interface HarnessIndex {
  readonly formatVersion: typeof HARNESS_FORMAT_VERSION;
  readonly candidateId: string;
  readonly manifestId: string;
  readonly positive: readonly IndexStep[];
  readonly negativeControl: readonly IndexStep[];
  readonly inputs: readonly IndexInput[];
}

/** Canonical JSON: sorted keys, so the same manifest always writes the same bytes. */
function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => sortKeys(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function pad(position: number): string {
  return String(position).padStart(POSITION_WIDTH, '0');
}

/** Refuses content a built-in secret pattern matches. The value is never put in the error (§8.7). */
function assertNoSecret(text: string, file: string): void {
  if (redactBuiltinSecrets(text) !== text) {
    throw new ValidationError('harness content contains a secret-like value', {
      detail: `refusing to write ${file}: it holds a secret-like value; use a reference (§8.7)`,
    });
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason: unknown = signal.reason;
  if (isAppError(reason)) throw reason;
  throw new KillSwitchActiveError('harness scaffold aborted by the session kill switch');
}

/** Maps a failure to an `AppError`. Quota exhaustion is named, so the caller can tell a full tmpfs from a bug. */
function toScaffoldError(error: unknown): AppError {
  if (isAppError(error)) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new InternalError('harness scaffold failed: workspace quota exceeded', {
      detail: 'the sandbox workspace has no room for the harness',
      cause: error,
    });
  }
  return new InternalError('harness scaffold failed', { cause: error });
}

/** Copies a captured input by reference and hashes it in the same pass. Binary-safe: no text decode. */
async function copyWithHash(source: string, target: string): Promise<string> {
  const hash = createHash('sha256');
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source, { highWaterMark: COPY_CHUNK_BYTES }),
    tap,
    createWriteStream(target, { mode: PRIVATE_FILE_MODE }),
  );
  return hash.digest('hex');
}

/** Materialises a validated PoC-harness manifest as the candidate's harness tree (EXPLOIT-002). */
export async function scaffoldHarness(
  manifestInput: unknown,
  deps: HarnessScaffoldDeps,
): Promise<HarnessLayout> {
  const parsed = PocHarnessManifestSchema.safeParse(manifestInput);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
    deps.metrics.harnessScaffolded.inc({ result: 'failure' });
    throw new ValidationError('poc harness manifest failed validation', {
      detail: `invalid fields: ${[...new Set(paths)].join(', ')}`,
    });
  }
  const manifest = parsed.data;
  const tracer = trace.getTracer('@blackwing/agent-runtime');
  return tracer.startActiveSpan('exploit.scaffold', async (span) => {
    span.setAttributes({
      candidateId: manifest.candidateId,
      stepCount: manifest.steps.length + manifest.negativeControl.length,
    });
    try {
      const layout = await writeHarness(manifest, deps);
      deps.metrics.harnessScaffolded.inc({ result: 'success' });
      deps.log.info(
        {
          candidateId: manifest.candidateId,
          stepCount: manifest.steps.length + manifest.negativeControl.length,
          workspace: deps.workspaceDir,
        },
        'poc harness scaffolded',
      );
      return layout;
    } catch (error) {
      deps.metrics.harnessScaffolded.inc({ result: 'failure' });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}

async function writeHarness(
  manifest: PocHarnessManifest,
  deps: HarnessScaffoldDeps,
): Promise<HarnessLayout> {
  const root = join(deps.workspaceDir, HARNESS_DIR, manifest.candidateId);
  await mkdir(join(deps.workspaceDir, HARNESS_DIR), { recursive: true });
  try {
    await mkdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ConflictError('a harness is already scaffolded for this candidate');
    }
    throw toScaffoldError(error);
  }

  const files: string[] = [];
  const writeFileOp = deps.io?.writeFile ?? writeFile;
  const writeText = async (relative: string, text: string): Promise<void> => {
    assertNotAborted(deps.signal);
    assertNoSecret(text, relative);
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFileOp(join(root, relative), text, { mode: PRIVATE_FILE_MODE });
    files.push(relative);
  };
  try {
    const positive = await writeSteps(manifest.steps, POSITIVE_PHASE, writeText);
    const negativeControl = await writeSteps(manifest.negativeControl, NEGATIVE_PHASE, writeText);
    const inputs = await writeInputs(manifest, root, deps, files);

    await writeText('manifest.json', canonicalJson(manifest));
    const index: HarnessIndex = {
      formatVersion: HARNESS_FORMAT_VERSION,
      candidateId: manifest.candidateId,
      manifestId: manifest.id,
      positive,
      negativeControl,
      inputs,
    };
    await writeText('harness.json', canonicalJson(index));

    assertNotAborted(deps.signal);
    await writeFileOp(join(root, 'runner'), HARNESS_RUNNER_SOURCE, { mode: RUNNER_MODE });
    await chmod(join(root, 'runner'), RUNNER_MODE);
    files.push('runner');

    await deps.audit({
      type: 'harness.scaffolded',
      candidateId: manifest.candidateId,
      stepCount: manifest.steps.length + manifest.negativeControl.length,
    });
    return { root, files };
  } catch (error) {
    // Fail closed: a partial tree never stays in the workspace (a failed scaffold leaves nothing behind).
    await rm(root, { recursive: true, force: true });
    throw toScaffoldError(error);
  }
}

async function writeSteps(
  steps: readonly HarnessStep[],
  phase: typeof POSITIVE_PHASE | typeof NEGATIVE_PHASE,
  writeText: (relative: string, text: string) => Promise<void>,
): Promise<IndexStep[]> {
  const entries: IndexStep[] = [];
  for (const [position, step] of steps.entries()) {
    const file = `steps/${phase}/${pad(position)}-${step.ref}.json`;
    await writeText(file, canonicalJson(step));
    entries.push({ ref: step.ref, kind: step.kind, file });
  }
  return entries;
}

async function writeInputs(
  manifest: PocHarnessManifest,
  root: string,
  deps: HarnessScaffoldDeps,
  files: string[],
): Promise<IndexInput[]> {
  const refs = [...new Set(manifest.inputsRef)];
  const inputs: IndexInput[] = [];
  for (const [position, ref] of refs.entries()) {
    const source = await deps.resolveInput(ref);
    if (source === null) {
      throw new ValidationError('harness input is not resolvable from evidence', {
        detail: `unresolved input ref: ${ref}`,
      });
    }
    assertNotAborted(deps.signal);
    const file = `inputs/${position}.bin`;
    await mkdir(dirname(join(root, file)), { recursive: true });
    const sha256 = await copyWithHash(source.path, join(root, file));
    files.push(file);
    inputs.push({ ref, file, sha256 });
  }
  return inputs;
}
