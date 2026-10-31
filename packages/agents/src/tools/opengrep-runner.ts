/**
 * CODESPEC-004 (#511): the `opengrep` pass that finds candidate sinks by class (CONTEXT_PACK §5, REFERENCES §5).
 *
 * `opengrep` is LGPL-2.1 and ships as a separate binary in the sandbox image. It is run here as a subprocess
 * through `execFile` (never linked, never imported), with the repo's own rules only (never Semgrep registry
 * rules). Output is deterministic and non-authoritative: a match is a sink candidate, never a finding (§1.1).
 *
 * Every failure degrades instead of throwing: a timeout, a non-zero exit, a missing binary or unparseable output
 * keeps whatever matches were recovered and sets `partial` with a reason, so the code specialist session never
 * crashes (EDGE: subprocess failure).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { type CodeLocation, CodeLocationSchema, cweIdSchema } from '@blackwing/contracts';

/** Default wall-clock limit for one opengrep pass. */
const OPENGREP_DEFAULT_TIMEOUT_MS = 120_000;
/** Targets larger than this are skipped by the engine (binary blobs, minified bundles). */
const OPENGREP_MAX_TARGET_BYTES = 1_000_000;
/** Largest stdout the pass will buffer (64 MiB). */
const MAX_STDOUT_BYTES = 67_108_864;
/** Fixed PATH for the child; the host environment is never inherited (§4.3, never read process.env here). */
const CHILD_PATH = '/usr/local/bin:/usr/bin:/bin';

/** One sink candidate. `wstgRef` and `owaspRef` come from the rule metadata. */
export interface OpengrepMatch {
  cweId: string;
  ruleId: string;
  wstgRef?: string;
  owaspRef?: string;
  location: CodeLocation;
}

interface OpengrepSkip {
  path: string;
  reason: string;
}

export interface OpengrepRunOptions {
  /** Absolute path to the pinned opengrep binary. */
  binaryPath: string;
  /** Directory of the Blackwing-authored rule files (`packages/agents/rules/whitebox`). */
  rulesDir: string;
  /** Read-only mounted source tree to scan. */
  targetDir: string;
  /** Provenance written into every location (§8.9). */
  repoRef: string;
  commitSha: string;
  timeoutMs?: number;
}

export interface OpengrepRunResult {
  matches: OpengrepMatch[];
  /** True when the pass did not complete cleanly; `partialReasons` says why. */
  partial: boolean;
  partialReasons: string[];
  /** Files and binaries the engine declined, each with its reason (binary, oversized or minified). */
  skipped: OpengrepSkip[];
  filesScanned: number;
  /** sha256 over the rule files (name and content), recorded for §8.9. */
  ruleSetSha: string;
}

/** Engine output (semgrep-compatible JSON). Parsed at the boundary: anything unexpected fails the parse. */
const engineOutputSchema = z.object({
  results: z
    .array(
      z.object({
        check_id: z.string().min(1),
        path: z.string().min(1),
        start: z.object({ line: z.int().min(1) }),
        end: z.object({ line: z.int().min(1) }).optional(),
        extra: z
          .object({
            metadata: z
              .object({
                cwe: z.union([z.string(), z.array(z.string())]).optional(),
                wstg: z.string().optional(),
                owasp: z.union([z.string(), z.array(z.string())]).optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  errors: z.array(z.unknown()).default([]),
  paths: z
    .object({
      scanned: z.array(z.string()).default([]),
      skipped: z.array(z.object({ path: z.string(), reason: z.string().optional() })).default([]),
    })
    .optional(),
});

/** The first CWE a rule declares, normalised to `CWE-<n>`; undefined when the metadata is missing or malformed. */
function cweFromMetadata(raw: string | readonly string[] | undefined): string | undefined {
  const first = typeof raw === 'string' ? raw : raw?.[0];
  const match = first?.match(/CWE-\d+/);
  const parsed = cweIdSchema.safeParse(match?.[0]);
  return parsed.success ? parsed.data : undefined;
}

/** Deterministic sha256 over the rule files, sorted by name. Changing any rule changes the digest. */
export async function ruleSetSha(rulesDir: string): Promise<string> {
  const names = (await readdir(rulesDir)).filter((n) => /\.ya?ml$/.test(n)).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name).update('\0');
    hash.update(await readFile(join(rulesDir, name))).update('\0');
  }
  return hash.digest('hex');
}

interface ExecOutcome {
  stdout: string;
  failure?: { reason: string };
}

/** Runs the binary as a child process. Resolves with stdout even when the child failed, so matches are kept. */
function execOpengrep(options: OpengrepRunOptions): Promise<ExecOutcome> {
  const args = [
    '--json',
    '--metrics=off',
    '--disable-version-check',
    '--max-target-bytes',
    String(OPENGREP_MAX_TARGET_BYTES),
    '--config',
    options.rulesDir,
    '.',
  ];
  return new Promise((resolve) => {
    execFile(
      options.binaryPath,
      args,
      {
        cwd: options.targetDir,
        env: { PATH: CHILD_PATH },
        timeout: options.timeoutMs ?? OPENGREP_DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        const out = typeof stdout === 'string' ? stdout : '';
        if (!error) {
          resolve({ stdout: out });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (error.killed || error.signal) {
          resolve({ stdout: out, failure: { reason: 'timeout' } });
        } else if (code === 'ENOENT' || code === 'EACCES') {
          resolve({ stdout: '', failure: { reason: 'binary_unavailable' } });
        } else {
          resolve({ stdout: out, failure: { reason: `exit_${String(error.code ?? 'unknown')}` } });
        }
      },
    );
  });
}

/**
 * Runs the pinned opengrep binary over `targetDir` and returns CWE-tagged sink candidates. Never throws for an
 * engine failure; the result says `partial` and why.
 */
export async function runOpengrep(options: OpengrepRunOptions): Promise<OpengrepRunResult> {
  const sha = await ruleSetSha(options.rulesDir);
  const { stdout, failure } = await execOpengrep(options);
  const partialReasons: string[] = failure ? [failure.reason] : [];
  const result = (
    matches: OpengrepMatch[],
    skipped: OpengrepSkip[],
    filesScanned: number,
  ): OpengrepRunResult => ({
    matches,
    partial: partialReasons.length > 0,
    partialReasons,
    skipped,
    filesScanned,
    ruleSetSha: sha,
  });

  if (stdout.trim() === '') {
    return result([], [], 0);
  }
  let json: unknown;
  try {
    json = JSON.parse(stdout) as unknown;
  } catch {
    partialReasons.push('unparseable_output');
    return result([], [], 0);
  }
  const parsed = engineOutputSchema.safeParse(json);
  if (!parsed.success) {
    partialReasons.push('unparseable_output');
    return result([], [], 0);
  }

  const data = parsed.data;
  if (data.errors.length > 0) {
    partialReasons.push('engine_errors');
  }
  const matches: OpengrepMatch[] = [];
  let droppedUnlocatable = 0;
  for (const hit of data.results) {
    const cweId = cweFromMetadata(hit.extra?.metadata?.cwe);
    const location = CodeLocationSchema.safeParse({
      repoRef: options.repoRef,
      commitSha: options.commitSha,
      path: hit.path,
      startLine: hit.start.line,
      endLine: hit.end?.line,
    });
    if (cweId === undefined || !location.success) {
      droppedUnlocatable += 1;
      continue;
    }
    const meta = hit.extra?.metadata;
    const owaspRaw = meta?.owasp;
    const owaspRef = typeof owaspRaw === 'string' ? owaspRaw : owaspRaw?.[0];
    matches.push({
      cweId,
      ruleId: hit.check_id.slice(hit.check_id.lastIndexOf('.') + 1),
      ...(meta?.wstg === undefined ? {} : { wstgRef: meta.wstg }),
      ...(owaspRef === undefined ? {} : { owaspRef }),
      location: location.data,
    });
  }
  if (droppedUnlocatable > 0) {
    partialReasons.push('unlocatable_matches');
  }
  const skipped = (data.paths?.skipped ?? []).map((s) => ({
    path: s.path,
    reason: s.reason ?? 'skipped_by_engine',
  }));
  return result(matches, skipped, data.paths?.scanned.length ?? 0);
}
