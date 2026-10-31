import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { harnessStepSchema, PocHarnessManifestSchema } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import { HARNESS_RUNNER_SOURCE } from './runner-source.js';
import { HARNESS_FORMAT_VERSION, type HarnessLayout } from './scaffold.js';

/**
 * Dry-run check that a scaffolded harness is self-contained (EXPLOIT-002, defence in depth over EXPLOIT-001). It
 * confirms that every file the index references exists and is in the layout, that every step parses against the
 * strict contract (so no inline shell or body can ride along), that every captured input matches its sha256, and that
 * the runner is the exact one this build ships. It reads files only and never runs them.
 */

const indexStepSchema = z.strictObject({ ref: z.string(), kind: z.string(), file: z.string() });
const indexSchema = z.strictObject({
  formatVersion: z.literal(HARNESS_FORMAT_VERSION),
  candidateId: z.string(),
  manifestId: z.string(),
  positive: z.array(indexStepSchema),
  negativeControl: z.array(indexStepSchema),
  inputs: z.array(z.strictObject({ ref: z.string(), file: z.string(), sha256: z.string() })),
});
type VerifiedIndex = z.infer<typeof indexSchema>;

const RUNNER_FILE = 'runner';
const HARNESS_INDEX_FILE = 'harness.json';
const MANIFEST_FILE = 'manifest.json';

/**
 * Throws `VALIDATION_FAILED` naming every problem by path and never by value. Resolves when the layout is sound.
 */
export async function verifyScaffold(layout: HarnessLayout): Promise<void> {
  const problems: string[] = [];
  const listed = new Set(layout.files);
  const referenced = new Set<string>([MANIFEST_FILE, HARNESS_INDEX_FILE, RUNNER_FILE]);

  const read = async (relative: string): Promise<string | null> => {
    try {
      return await readFile(join(layout.root, relative), 'utf8');
    } catch {
      problems.push(`missing file: ${relative}`);
      return null;
    }
  };

  const indexText = await read(HARNESS_INDEX_FILE);
  const index = parseIndex(indexText, problems);
  if (index !== null) {
    for (const entry of [...index.positive, ...index.negativeControl]) {
      referenced.add(entry.file);
      const text = await read(entry.file);
      if (text === null) continue;
      const parsed = parseStep(text);
      if (parsed === null) {
        problems.push(`step is not a valid declarative step: ${entry.file}`);
      } else if (parsed.ref !== entry.ref || parsed.kind !== entry.kind) {
        problems.push(`step does not match its index entry: ${entry.file}`);
      }
    }
    for (const input of index.inputs) {
      referenced.add(input.file);
      await verifyInput(layout.root, input.file, input.sha256, problems);
    }
  }

  const manifestText = await read(MANIFEST_FILE);
  if (manifestText !== null && index !== null) {
    const manifest = parseManifest(manifestText);
    if (manifest?.candidateId !== index.candidateId) {
      problems.push('manifest.json does not validate or names another candidate');
    }
  }

  const runnerText = await read(RUNNER_FILE);
  if (runnerText !== null && runnerText !== HARNESS_RUNNER_SOURCE) {
    problems.push('runner is not the runner this build ships');
  }

  for (const file of referenced) {
    if (!listed.has(file)) problems.push(`referenced file is not in the layout: ${file}`);
  }

  if (problems.length > 0) {
    throw new ValidationError('harness scaffold failed verification', {
      detail: problems.join('; '),
    });
  }
}

function parseIndex(text: string | null, problems: string[]): VerifiedIndex | null {
  if (text === null) return null;
  const parsed = safeJson(text);
  if (parsed === undefined) {
    problems.push('harness.json is not valid JSON');
    return null;
  }
  const index = indexSchema.safeParse(parsed);
  if (!index.success) {
    problems.push('harness.json does not match the index format');
    return null;
  }
  return index.data;
}

function parseManifest(text: string): { candidateId: string } | null {
  const parsed = safeJson(text);
  const manifest = PocHarnessManifestSchema.safeParse(parsed);
  return manifest.success ? { candidateId: manifest.data.candidateId } : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseStep(text: string): { ref: string; kind: string } | null {
  const parsed = harnessStepSchema.safeParse(safeJson(text));
  return parsed.success ? { ref: parsed.data.ref, kind: parsed.data.kind } : null;
}

async function verifyInput(
  root: string,
  file: string,
  sha256: string,
  problems: string[],
): Promise<void> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(join(root, file))) hash.update(chunk as Buffer);
  } catch {
    problems.push(`missing input: ${file}`);
    return;
  }
  if (hash.digest('hex') !== sha256) problems.push(`input sha256 mismatch: ${file}`);
}
