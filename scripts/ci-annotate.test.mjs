// Tests for the CI annotation filter (scripts/ci-annotate.mjs) and the problem matchers in
// .github/actions/problem-matchers (CI-002, #136): a real type error and a real `any` must come out
// as repository-relative lines that the matchers turn into annotations.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ESLint } from 'eslint';

import { SUMMARY_LIMIT, createNormalizer, summarize, workspaceDirs } from './ci-annotate.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const MATCHERS = path.join(REPO_ROOT, '.github', 'actions', 'problem-matchers');

/**
 * The first pattern of a problem-matcher file, as a RegExp plus its group indexes.
 * @param {string} name
 * @returns {{ re: RegExp, groups: Record<string, number> }}
 */
function matcher(name) {
  /** @type {unknown} */
  const raw = JSON.parse(readFileSync(path.join(MATCHERS, name), 'utf8'));
  /** @typedef {{ problemMatcher: { pattern: ({ regexp: string } & Record<string, unknown>)[] }[] }} MatcherFile */
  const doc = /** @type {MatcherFile} */ (raw);
  const pattern = doc.problemMatcher[0]?.pattern[0];
  assert.ok(pattern, `${name} has no pattern`);
  /** @type {Record<string, number>} */
  const groups = {};
  for (const [k, v] of Object.entries(pattern)) if (typeof v === 'number') groups[k] = v;
  return { re: new RegExp(pattern.regexp), groups };
}

/**
 * Applies a matcher to a line like the runner does.
 * @param {string} name
 * @param {string} line
 * @returns {Record<string, string> | null}
 */
function annotate(name, line) {
  const { re, groups } = matcher(name);
  const m = re.exec(line);
  if (m === null) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, i] of Object.entries(groups)) out[k] = m[i] ?? '';
  return out;
}

/**
 * Runs lines through a fresh normaliser.
 * @param {string[]} lines
 * @param {{ root?: string, dirs?: Map<string, string> }} [options]
 */
function normalize(lines, options = {}) {
  const n = createNormalizer({
    root: options.root ?? REPO_ROOT,
    dirs: options.dirs ?? workspaceDirs(REPO_ROOT),
  });
  const out = lines.map((l) => n.line(l));
  return { out, diagnostics: n.diagnostics(), cache: n.cache() };
}

describe('workspaceDirs', () => {
  it('maps every workspace package and the Turborepo root alias', () => {
    const dirs = workspaceDirs(REPO_ROOT);
    assert.equal(dirs.get('//'), '.');
    assert.equal(dirs.get('@blackwing/root'), '.');
    assert.equal(dirs.get('@blackwing/ids'), 'packages/ids');
    assert.equal(dirs.get('@blackwing/api'), 'apps/api');
  });
});

describe('a type error fails typecheck and is annotated', () => {
  it('re-roots a real tsc diagnostic from the package directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bw-annotate-tsc-'));
    try {
      const pkg = path.join(root, 'packages', 'demo');
      mkdirSync(path.join(pkg, 'src'), { recursive: true });
      writeFileSync(
        path.join(pkg, 'tsconfig.json'),
        JSON.stringify({
          extends: path.join(REPO_ROOT, 'tsconfig.base.json'),
          // `types: []`: the temp dir has no node_modules/@types.
          compilerOptions: { noEmit: true, composite: false, incremental: false, types: [] },
          include: ['src'],
        }),
      );
      writeFileSync(path.join(pkg, 'package.json'), '{"type":"module"}');
      writeFileSync(path.join(pkg, 'src', 'bad.ts'), "export const n: number = 'one';\n");
      const tsc = spawnSync(
        path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'),
        ['-p', 'tsconfig.json', '--pretty', 'false'],
        { cwd: pkg, encoding: 'utf8' },
      );
      assert.notEqual(tsc.status, 0, 'tsc must fail on a type error');
      const lines = tsc.stdout
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => `@blackwing/demo:typecheck: ${l}`);
      const { out, diagnostics } = normalize(lines, {
        root,
        dirs: new Map([['@blackwing/demo', 'packages/demo']]),
      });
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, 'TS2322');
      const line = out.find((l) => l.startsWith('packages/demo/src/bad.ts(1,14): error TS2322: '));
      assert.ok(line, `no canonical tsc line in:\n${out.join('\n')}`);
      assert.deepEqual(
        { ...annotate('tsc.json', line), message: '' },
        {
          file: 'packages/demo/src/bad.ts',
          line: '1',
          column: '14',
          severity: 'error',
          code: 'TS2322',
          message: '',
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps root-task paths (//#lint:root runs tsc from the root) and absolute paths', () => {
    const { out } = normalize([
      "//:lint:root: scripts/x.mjs(4,2): error TS2304: Cannot find name 'y'.",
      `@blackwing/ids:typecheck: ${path.join(REPO_ROOT, 'packages/ids/src/a.ts')}(1,1): error TS1005: ';' expected.`,
    ]);
    assert.equal(out[0], "scripts/x.mjs(4,2): error TS2304: Cannot find name 'y'.");
    assert.equal(out[1], "packages/ids/src/a.ts(1,1): error TS1005: ';' expected.");
  });

  it('learns an unknown package directory from the pnpm script banner', () => {
    const { out } = normalize(
      [
        `@x/new:typecheck: > @x/new@0.0.0 typecheck ${path.join(REPO_ROOT, 'packages', 'new')}`,
        '@x/new:typecheck: src/i.ts(2,3): error TS2551: Property does not exist.',
      ],
      { dirs: new Map() },
    );
    assert.equal(out[1], 'packages/new/src/i.ts(2,3): error TS2551: Property does not exist.');
  });
});

describe('`any` fails lint and is annotated', () => {
  it('turns real ESLint stylish output under a Turborepo prefix into one annotation', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
    const results = await eslint.lintFiles([
      path.join(REPO_ROOT, 'scripts', 'fixtures', 'eslint', 'explicit-any.ts'),
    ]);
    assert.ok(
      results.some((r) => r.errorCount > 0),
      '`any` must be a lint error',
    );
    const formatter = await eslint.loadFormatter('stylish');
    const text = await formatter.format(results);
    const lines = text.split('\n').map((l) => `@blackwing/root:lint:root: ${l}`);
    const { out, diagnostics } = normalize(lines);
    const any = diagnostics.find((d) => d.code === '@typescript-eslint/no-explicit-any');
    assert.ok(any, `no no-explicit-any diagnostic in:\n${out.join('\n')}`);
    assert.equal(any.file, 'scripts/fixtures/eslint/explicit-any.ts');
    const line = out.find((l) => l.includes('[@typescript-eslint/no-explicit-any]'));
    assert.ok(line);
    const a = annotate('eslint.json', line);
    assert.ok(a);
    assert.equal(a.file, 'scripts/fixtures/eslint/explicit-any.ts');
    assert.equal(a.severity, 'error');
    assert.equal(a.code, '@typescript-eslint/no-explicit-any');
    assert.equal(a.line, String(any.line));
  });

  it('handles messages without a rule id and resets the file on a blank line', () => {
    const file = path.join(REPO_ROOT, 'apps/api/src/main.ts');
    const { out, diagnostics } = normalize([
      `@blackwing/api:lint: ${file}`,
      '@blackwing/api:lint:   3:1  error  Parsing error: Unexpected token',
      '@blackwing/api:lint: ',
      '@blackwing/api:lint:   9:9  error  not a diagnostic without a file header',
    ]);
    assert.equal(out[1], 'apps/api/src/main.ts:3:1: error Parsing error: Unexpected token');
    assert.equal(
      annotate('eslint.json', 'apps/api/src/main.ts:3:1: error Parsing error: Unexpected token')
        ?.code,
      '',
    );
    assert.equal(diagnostics.length, 1);
  });

  it('keeps per-package file context when Turborepo interleaves packages', () => {
    const a = path.join(REPO_ROOT, 'packages/ids/src/a.ts');
    const b = path.join(REPO_ROOT, 'packages/time/src/b.ts');
    const { diagnostics } = normalize([
      `@blackwing/ids:lint: ${a}`,
      `@blackwing/time:lint: ${b}`,
      '@blackwing/ids:lint:   1:1  warning  Unused  no-unused-vars',
      '@blackwing/time:lint:   2:2  error  Bad  eqeqeq',
    ]);
    assert.deepEqual(
      diagnostics.map((d) => [d.file, d.severity, d.code]),
      [
        ['packages/ids/src/a.ts', 'warning', 'no-unused-vars'],
        ['packages/time/src/b.ts', 'error', 'eqeqeq'],
      ],
    );
  });
});

describe('prettier matcher', () => {
  it('annotates unformatted files but not the trailing summary line', () => {
    assert.equal(
      annotate('prettier.json', '[warn] docs/runbooks/ci.md')?.file,
      'docs/runbooks/ci.md',
    );
    assert.equal(
      annotate(
        'prettier.json',
        '[warn] Code style issues found in 2 files. Run Prettier with --write to fix.',
      ),
      null,
    );
  });
});

describe('summary and cache reporting', () => {
  it('reports a full Turborepo cache hit on a re-run', () => {
    const { cache, out } = normalize([
      ' Tasks:    4 successful, 4 total',
      'Cached:    4 cached, 4 total',
    ]);
    assert.deepEqual(cache, { cached: 4, total: 4 });
    assert.equal(out[1], 'Cached:    4 cached, 4 total');
    assert.match(
      summarize('typecheck', [], cache),
      /4\/4 tasks cached \(full Turborepo cache hit\)/,
    );
    assert.doesNotMatch(summarize('typecheck', [], { cached: 1, total: 4 }), /full/);
  });

  it('lists the first diagnostics, escapes pipes and counts the rest', () => {
    const many = Array.from({ length: SUMMARY_LIMIT + 3 }, (_, i) => ({
      tool: /** @type {const} */ ('eslint'),
      file: 'a.ts',
      line: i + 1,
      column: 1,
      severity: /** @type {'warning' | 'error'} */ (i === 0 ? 'warning' : 'error'),
      code: 'r',
      message: 'a | b',
      pkg: 'p',
    }));
    const md = summarize('lint', many, null);
    assert.match(md, new RegExp(`${String(SUMMARY_LIMIT + 2)} error\\(s\\), 1 warning\\(s\\)`));
    assert.match(md, /a \\\| b/);
    assert.match(md, /3 more not shown/);
    assert.match(summarize('lint', [], null), /No diagnostics\./);
  });

  it('runs as a pipe filter, exits 0 and appends the job summary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-annotate-cli-'));
    try {
      const summaryFile = path.join(dir, 'summary.md');
      const r = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'ci-annotate.mjs'), '--task', 'typecheck'],
        {
          input:
            '@blackwing/ids:typecheck: src/a.ts(1,2): error TS2322: Nope.\nCached:    0 cached, 1 total\n',
          encoding: 'utf8',
          env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
        },
      );
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^packages\/ids\/src\/a\.ts\(1,2\): error TS2322: Nope\.$/m);
      const md = readFileSync(summaryFile, 'utf8');
      assert.match(md, /### typecheck/);
      assert.match(md, /1 error\(s\)/);
      assert.match(md, /0\/1 tasks cached/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
