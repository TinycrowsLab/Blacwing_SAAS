import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type OpengrepRunOptions, ruleSetSha, runOpengrep } from './opengrep-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const rulesDir = resolve(here, '../../rules/whitebox');
const COMMIT = 'a'.repeat(40);

const hit = {
  check_id: 'rules.bw-whitebox-cwe-89-query-concat-js',
  path: 'src/db.ts',
  start: { line: 42 },
  end: { line: 42 },
  extra: { metadata: { cwe: 'CWE-89', wstg: 'WSTG-INPV-05', owasp: 'A03:2021' } },
};

let workDir: string;
let targetDir: string;

/** Writes a POSIX shell stand-in for the engine. It is a separate process, which is what these tests exercise. */
async function fakeEngine(name: string, body: string): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

function options(binaryPath: string, extra: Partial<OpengrepRunOptions> = {}): OpengrepRunOptions {
  return {
    binaryPath,
    rulesDir,
    targetDir,
    repoRef: 'repo:acme/shop',
    commitSha: COMMIT,
    ...extra,
  };
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'opengrep-runner-'));
  targetDir = join(workDir, 'src-tree');
  await mkdir(targetDir);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('runOpengrep matches', () => {
  it('returns CWE-tagged matches with CodeLocation provenance', async () => {
    const json = JSON.stringify({
      results: [hit],
      errors: [],
      paths: { scanned: ['src/db.ts'], skipped: [] },
    });
    const bin = await fakeEngine('match.sh', `printf '%s' '${json}'`);

    const result = await runOpengrep(options(bin));

    expect(result.partial).toBe(false);
    expect(result.partialReasons).toEqual([]);
    expect(result.filesScanned).toBe(1);
    expect(result.matches).toEqual([
      {
        cweId: 'CWE-89',
        ruleId: 'bw-whitebox-cwe-89-query-concat-js',
        wstgRef: 'WSTG-INPV-05',
        owaspRef: 'A03:2021',
        location: {
          repoRef: 'repo:acme/shop',
          commitSha: COMMIT,
          path: 'src/db.ts',
          startLine: 42,
          endLine: 42,
        },
      },
    ]);
  });

  it('runs the engine as a separate process with the rule directory, a fixed PATH and the target as cwd', async () => {
    const argsFile = join(workDir, 'args.txt');
    const cwdFile = join(workDir, 'cwd.txt');
    const bin = await fakeEngine(
      'argv.sh',
      `printf '%s\\n' "$@" > '${argsFile}'; pwd -P > '${cwdFile}'; printf '%s' '{"results":[]}'`,
    );

    await runOpengrep(options(bin));

    const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
    expect(args).toContain('--json');
    expect(args).toContain('--config');
    expect(args[args.indexOf('--config') + 1]).toBe(rulesDir);
    expect(args.at(-1)).toBe('.');
    expect((await readFile(cwdFile, 'utf8')).trim()).toBe(await realpath(targetDir));
  });

  it('accepts a zero-finding run and an empty stdout as a clean, empty result', async () => {
    const bin = await fakeEngine('empty.sh', `printf '%s' '{"results":[],"errors":[]}'`);
    const silent = await fakeEngine('silent.sh', 'exit 0');

    await expect(runOpengrep(options(bin))).resolves.toMatchObject({ matches: [], partial: false });
    await expect(runOpengrep(options(silent))).resolves.toMatchObject({
      matches: [],
      partial: false,
    });
  });

  it('drops matches with an unsafe path or no CWE and flags the run partial', async () => {
    const json = JSON.stringify({
      results: [
        { ...hit, path: '../outside/db.ts' },
        { ...hit, path: '/abs/db.ts' },
        { ...hit, extra: { metadata: {} } },
        { ...hit, path: 'src/ok.ts', start: { line: 3 } },
      ],
      errors: [],
    });
    const bin = await fakeEngine('unsafe.sh', `printf '%s' '${json}'`);

    const result = await runOpengrep(options(bin));

    expect(result.matches.map((m) => m.location.path)).toEqual(['src/ok.ts']);
    expect(result.partial).toBe(true);
    expect(result.partialReasons).toContain('unlocatable_matches');
  });

  it('reports engine-side skipped paths (binary or minified) with a reason', async () => {
    const json = JSON.stringify({
      results: [],
      errors: [],
      paths: {
        scanned: ['src/app.ts'],
        skipped: [
          { path: 'dist/bundle.min.js', reason: 'exceeded max target bytes' },
          { path: 'img/logo.png' },
        ],
      },
    });
    const bin = await fakeEngine('skip.sh', `printf '%s' '${json}'`);

    const result = await runOpengrep(options(bin));

    expect(result.skipped).toEqual([
      { path: 'dist/bundle.min.js', reason: 'exceeded max target bytes' },
      { path: 'img/logo.png', reason: 'skipped_by_engine' },
    ]);
    expect(result.filesScanned).toBe(1);
  });

  it('flags engine-reported errors as partial while keeping the matches', async () => {
    const json = JSON.stringify({ results: [hit], errors: [{ code: 3, message: 'parse error' }] });
    const bin = await fakeEngine('errs.sh', `printf '%s' '${json}'`);

    const result = await runOpengrep(options(bin));

    expect(result.matches).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.partialReasons).toEqual(['engine_errors']);
  });
});

describe('runOpengrep degrades instead of crashing', () => {
  it('keeps the matches recovered before a timeout and flags the run partial', async () => {
    const json = JSON.stringify({ results: [hit], errors: [] });
    // `exec` replaces the shell so the timeout kills the process that holds stdout.
    const bin = await fakeEngine('slow.sh', `printf '%s' '${json}'; exec sleep 30`);

    const result = await runOpengrep(options(bin, { timeoutMs: 400 }));

    expect(result.partial).toBe(true);
    expect(result.partialReasons).toEqual(['timeout']);
    expect(result.matches).toHaveLength(1);
  });

  it('keeps matches on a non-zero exit and records the exit code', async () => {
    const json = JSON.stringify({ results: [hit], errors: [] });
    const bin = await fakeEngine('exit2.sh', `printf '%s' '${json}'; exit 2`);

    const result = await runOpengrep(options(bin));

    expect(result.matches).toHaveLength(1);
    expect(result.partialReasons).toEqual(['exit_2']);
  });

  it('returns an empty partial result when the binary is missing', async () => {
    const result = await runOpengrep(options(join(workDir, 'does-not-exist')));

    expect(result.matches).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.partialReasons).toEqual(['binary_unavailable']);
  });

  it('flags unparseable output as partial and never throws', async () => {
    const bin = await fakeEngine('garbage.sh', `printf 'not json at all'`);

    const result = await runOpengrep(options(bin));

    expect(result.matches).toEqual([]);
    expect(result.partialReasons).toEqual(['unparseable_output']);
  });

  it('rejects output that does not match the engine schema', async () => {
    const bin = await fakeEngine('shape.sh', `printf '%s' '{"results":[{"check_id":"x"}]}'`);

    const result = await runOpengrep(options(bin));

    expect(result.matches).toEqual([]);
    expect(result.partialReasons).toEqual(['unparseable_output']);
  });
});

describe('ruleSetSha', () => {
  it('is stable for the same rules and changes when any rule file changes', async () => {
    const dir = join(workDir, 'rules-a');
    await mkdir(dir);
    await writeFile(join(dir, 'a.yaml'), 'rules: []\n');
    await writeFile(join(dir, 'b.yaml'), 'rules: [1]\n');
    const first = await ruleSetSha(dir);

    expect(await ruleSetSha(dir)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(join(dir, 'b.yaml'), 'rules: [2]\n');
    expect(await ruleSetSha(dir)).not.toBe(first);
  });

  it('pins the shipped rule set to a digest that the run records', async () => {
    const bin = await fakeEngine('sha.sh', `printf '%s' '{"results":[]}'`);

    const result = await runOpengrep(options(bin));

    expect(result.ruleSetSha).toBe(await ruleSetSha(rulesDir));
  });
});
