import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { AppError, type ErrorCode } from '@blackwing/errors';

import { PERSONA_NAMES, type PersonaName } from './persona.js';

/**
 * The prompt file format and loader (REGISTRY-002, §8.9 per-run version pinning).
 *
 * A prompt lives at `prompts/<persona>/<semver>.md`: YAML-style front-matter (a flat, strict subset:
 * scalar `key: value` lines and a `|` block for the changelog) followed by the body. The loader
 * hashes the canonical body (LF line endings, UTF-8 NFC) and checks it against the committed
 * `prompts.lock.json`; any mismatch fails closed. The lock is updated only by the release process.
 */

export type PromptMode = 'production' | 'dev' | 'eval';
export const PROMPT_STATUSES = ['draft', 'released', 'deprecated'] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];

/** Failure of prompt parsing, lookup or integrity checks. Carries a registered error code. */
export class PromptError extends AppError {
  constructor(code: Extract<ErrorCode, `PROMPT_${string}`>, message: string, cause?: unknown) {
    super(code, message, cause === undefined ? {} : { cause });
    this.name = 'PromptError';
  }
}

const MD_EXT = '.md';
const SEMVER_PARTS = 3;
const LIMIT = { changelog: 4000, author: 256, id: 128 } as const;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Compares two `x.y.z` strings numerically. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < SEMVER_PARTS; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const promptFrontMatterSchema = z.strictObject({
  persona: z.enum(PERSONA_NAMES),
  version: z.string().regex(SEMVER, 'must be a semver (x.y.z)'),
  status: z.enum(PROMPT_STATUSES),
  changelog: z.string().trim().min(1).max(LIMIT.changelog),
  authoredBy: z.string().trim().min(1).max(LIMIT.author),
  evalRunId: z.string().trim().min(1).max(LIMIT.id).optional(),
  tierHint: z.enum(['deep', 'standard', 'fast']).optional(),
});
export type PromptFrontMatter = z.infer<typeof promptFrontMatterSchema>;

/** Canonical body: CRLF/CR to LF, UTF-8 NFC, leading blank lines dropped, one trailing LF. */
export function canonicalBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').normalize('NFC').replace(/^\n+/, '').replace(/\n*$/, '\n');
}

/** SHA-256 (hex) of the canonical body encoded as UTF-8. */
export function hashPromptBody(body: string): string {
  return createHash('sha256').update(canonicalBody(body), 'utf8').digest('hex');
}

function invalid(detail: string, cause?: unknown): PromptError {
  return new PromptError('PROMPT_INVALID', `PROMPT_INVALID: ${detail}`, cause);
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch (e) {
      throw invalid('bad quoted front-matter value', e);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/** Parses the strict front-matter subset. Throws PROMPT_INVALID on anything else. */
function parseFrontMatterBlock(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z][A-Za-z0-9]*):(?:\s+(.*))?$/.exec(line);
    if (!m) throw invalid(`bad front-matter line ${String(i + 1)}`);
    const key = m[1] ?? '';
    if (key in out) throw invalid(`duplicate key ${key}`);
    const val = (m[2] ?? '').trim();
    if (val === '|') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+\S.*|\s*)$/.test(lines[i + 1] ?? '')) {
        i += 1;
        block.push((lines[i] ?? '').replace(/^ {1,4}/, ''));
      }
      out[key] = block.join('\n').trim();
    } else {
      out[key] = unquote(val);
    }
  }
  return out;
}

export interface ParsedPrompt {
  readonly meta: PromptFrontMatter;
  /** Canonical body (what is hashed). */
  readonly body: string;
}

/** Parses a prompt file's text. Throws {@link PromptError} (`PROMPT_INVALID`) when malformed. */
export function parsePromptFile(text: string): ParsedPrompt {
  const lines = text
    .replace(/^\u{FEFF}/u, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  if (lines[0]?.trim() !== '---') throw invalid('missing front-matter');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw invalid('unterminated front-matter');
  const raw = parseFrontMatterBlock(lines.slice(1, end));
  const result = promptFrontMatterSchema.safeParse(raw);
  if (!result.success) {
    throw invalid(
      result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
      result.error,
    );
  }
  const body = canonicalBody(lines.slice(end + 1).join('\n'));
  if (body.trim() === '') throw invalid('empty body');
  return { meta: result.data, body };
}

/** `prompts.lock.json`: persona to version to sha256. */
export const promptLockSchema = z.record(
  z.string(),
  z.record(z.string().regex(SEMVER), z.string().regex(/^[0-9a-f]{64}$/)),
);
export type PromptLock = z.infer<typeof promptLockSchema>;

export interface LoadedPrompt {
  readonly persona: PersonaName;
  readonly body: string;
  readonly version: string;
  readonly sha256: string;
  readonly status: PromptStatus;
  readonly meta: PromptFrontMatter;
}

export interface PromptLoaderOptions {
  /** Directory holding `<persona>/<semver>.md`. Defaults to the package's `prompts/`. */
  readonly promptsDir?: string;
  /** Lock contents; when absent, read from `lockPath` (default: the package's `prompts.lock.json`). */
  readonly lock?: PromptLock;
  readonly lockPath?: string;
  /** Defaults to `production` (fail closed): drafts are refused. */
  readonly mode?: PromptMode;
  /** Observability hook, e.g. to set `persona_prompt_version_info{persona,version}`. */
  readonly onLoaded?: (p: { persona: string; version: string; sha256: string }) => void;
}

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

function readLock(opts: PromptLoaderOptions): PromptLock {
  if (opts.lock) return opts.lock;
  const path = opts.lockPath ?? join(PKG_ROOT, 'prompts.lock.json');
  if (!existsSync(path)) return {};
  try {
    return promptLockSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    throw invalid('unreadable prompts.lock.json', e);
  }
}

function listVersions(dir: string, persona: string): string[] {
  const pdir = join(dir, persona);
  if (!existsSync(pdir)) return [];
  return readdirSync(pdir)
    .filter((f) => f.endsWith(MD_EXT))
    .map((f) => f.slice(0, -MD_EXT.length))
    .filter((v) => SEMVER.test(v))
    .sort(compareSemver);
}

function readOne(dir: string, persona: PersonaName, version: string): ParsedPrompt {
  const file = join(dir, persona, `${version}.md`);
  if (!existsSync(file)) {
    throw new PromptError(
      'PROMPT_NO_RELEASED_VERSION',
      `PROMPT_NO_RELEASED_VERSION: ${persona}@${version} not found`,
    );
  }
  const parsed = parsePromptFile(readFileSync(file, 'utf8'));
  if (parsed.meta.persona !== persona || parsed.meta.version !== version) {
    throw invalid(`front-matter does not match path ${persona}/${version}`);
  }
  return parsed;
}

/**
 * Loads a prompt. With no `version`, selects the highest `released` semver. A `draft` is only
 * loadable in `dev`/`eval` and only when requested explicitly. Non-draft prompts must match the
 * lock (a missing entry counts as a mismatch). Fails closed with a {@link PromptError}.
 */
export function loadPrompt(
  persona: PersonaName,
  version?: string,
  opts: PromptLoaderOptions = {},
): LoadedPrompt {
  if (!(PERSONA_NAMES as readonly string[]).includes(persona)) {
    throw invalid(`unknown persona ${persona}`);
  }
  const dir = opts.promptsDir ?? join(PKG_ROOT, 'prompts');
  const mode = opts.mode ?? 'production';
  let chosen = version;
  if (chosen === undefined) {
    const released = listVersions(dir, persona).findLast(
      (v) => readOne(dir, persona, v).meta.status === 'released',
    );
    if (released === undefined) {
      throw new PromptError('PROMPT_NO_RELEASED_VERSION', `PROMPT_NO_RELEASED_VERSION: ${persona}`);
    }
    chosen = released;
  } else if (!SEMVER.test(chosen)) {
    throw invalid(`bad version ${chosen}`);
  }
  const { meta, body } = readOne(dir, persona, chosen);
  if (meta.status === 'draft' && mode === 'production') {
    throw new PromptError('PROMPT_DRAFT_FORBIDDEN', `PROMPT_DRAFT_FORBIDDEN: ${persona}@${chosen}`);
  }
  const sha256 = hashPromptBody(body);
  if (meta.status !== 'draft') {
    const expected = readLock(opts)[persona]?.[chosen];
    if (expected !== sha256) {
      throw new PromptError('PROMPT_HASH_MISMATCH', `PROMPT_HASH_MISMATCH: ${persona}@${chosen}`);
    }
  }
  opts.onLoaded?.({ persona, version: chosen, sha256 });
  return { persona, body, version: chosen, sha256, status: meta.status, meta };
}

/** Builds the lock entry for a prompt text (used by the release process, REGISTRY-008). */
export function lockEntryFor(text: string): { persona: string; version: string; sha256: string } {
  const { meta, body } = parsePromptFile(text);
  return { persona: meta.persona, version: meta.version, sha256: hashPromptBody(body) };
}
