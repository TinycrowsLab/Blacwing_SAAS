// End-to-end self-tests for the git hooks (FOUND-006, #8): Husky's `prepare` install, the
// `pre-commit` (lint-staged + optional gitleaks), `commit-msg` (commitlint) and `pre-push`
// (`pnpm typecheck`) hooks, and the LF rule in .gitattributes.
//
// Each suite builds a throwaway git repository holding copies of the real hook scripts and tool
// configs, with node_modules linked to this repository's install, and drives it with real `git`
// commands. Nothing touches this repository's own git config or hooks. Child processes get a clean
// environment: no inherited GIT_* variables (these tests may run inside a hook), no HUSKY, no
// user or system git config.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import lintStaged from '../lint-staged.config.mjs';
import { MANIFEST_PATH } from './sync-labels.mjs';
import { REPO_ROOT, asObject, cleanEnv, readJsonObject } from './test-fixtures.mjs';

/** Repository files every fixture needs: hooks, tool configs and what they import. */
const FIXTURE_FILES = [
  '.husky/pre-commit',
  '.husky/commit-msg',
  '.husky/pre-push',
  '.gitattributes',
  '.prettierignore',
  'commitlint.config.mjs',
  'lint-staged.config.mjs',
  'eslint.config.mjs',
  'prettier.config.mjs',
  'tsconfig.base.json',
  'pnpm-workspace.yaml',
  'scripts/tsconfig.json',
  'scripts/commit-scopes.mjs',
  'scripts/check-layout.mjs',
  'scripts/sync-labels.mjs',
  MANIFEST_PATH,
];

const DEMO = 'packages/demo';
const HOOK_TIMEOUT_MS = 120_000;

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string, output: string }} RunResult
 * @typedef {{
 *   root: string,
 *   bin: string,
 *   run: (cmd: string, args: string[], extra?: Record<string, string>) => RunResult,
 *   git: (args: string[], extra?: Record<string, string>) => RunResult,
 *   write: (rel: string, text: string) => void,
 *   read: (rel: string) => string,
 *   head: () => string,
 *   committed: (rel: string) => string,
 *   cleanup: () => void,
 * }} HookRepo
 */

/**
 * Environment for the fixture's child processes.
 * @param {string} bin  directory of fake tools, searched first
 * @param {string} gitConfig  empty file used as the global git config
 * @param {Record<string, string>} extra
 * @returns {NodeJS.ProcessEnv}
 */
function fixtureEnv(bin, gitConfig, extra) {
  const env = cleanEnv();
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key === 'HUSKY') Reflect.deleteProperty(env, key);
  }
  return {
    ...env,
    PATH: `${bin}${path.delimiter}${env.PATH ?? ''}`,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_AUTHOR_NAME: 'Hook Test',
    GIT_AUTHOR_EMAIL: 'hooks@example.invalid',
    GIT_COMMITTER_NAME: 'Hook Test',
    GIT_COMMITTER_EMAIL: 'hooks@example.invalid',
    CI: '',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ...extra,
  };
}

/**
 * Writes an executable fake `gitleaks` that records its arguments and exits with `code`.
 * @param {string} bin
 * @param {number} code
 */
function fakeGitleaks(bin, code) {
  const file = path.join(bin, 'gitleaks');
  writeFileSync(
    file,
    `#!/bin/sh\necho "$@" >> "${path.join(bin, 'gitleaks.calls')}"\nexit ${String(code)}\n`,
  );
  chmodSync(file, 0o755);
}

/**
 * Creates a git repository with the real hooks installed through Husky, one TypeScript member
 * (`packages/demo`) and an initial commit.
 * @param {{ typecheck?: string, install?: boolean }} [options]
 *   typecheck: the fixture's root `typecheck` script (what `pnpm typecheck` runs in pre-push);
 *   install: run Husky's install (the root `prepare` script), default true
 * @returns {HookRepo}
 */
function makeHookRepo(options = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'bw-hooks-'));
  const root = path.join(base, 'repo');
  const bin = path.join(base, 'bin');
  const gitConfig = path.join(base, 'gitconfig');
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(gitConfig, '');
  fakeGitleaks(bin, 0);

  for (const rel of FIXTURE_FILES) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const rootManifest = readJsonObject(path.join(REPO_ROOT, 'package.json'));
  const rootScripts = asObject(rootManifest.scripts, 'package.json scripts');
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: '@blackwing/root',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: {
          prepare: rootScripts.prepare,
          typecheck: options.typecheck ?? 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(path.join(root, DEMO, 'src'), { recursive: true });
  writeFileSync(
    path.join(root, DEMO, 'package.json'),
    `${JSON.stringify({ name: '@blackwing/demo', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, DEMO, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: { rootDir: 'src', outDir: 'dist' },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(root, DEMO, 'src', 'index.ts'), "export const name = 'demo';\n");
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');

  /** @type {HookRepo['run']} */
  const run = (cmd, args, extra = {}) => {
    const result = spawnSync(cmd, args, {
      cwd: root,
      encoding: 'utf8',
      env: fixtureEnv(bin, gitConfig, extra),
      timeout: HOOK_TIMEOUT_MS,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: `${result.stdout}${result.stderr}`,
    };
  };
  /** @type {HookRepo['git']} */
  const git = (args, extra) => run('git', args, extra);
  /**
   * @param {string[]} args
   * @returns {string}
   */
  const gitOk = (args) => {
    const result = git(args);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.output}`);
    return result.stdout;
  };

  gitOk(['init', '--quiet', '--initial-branch=main']);
  gitOk(['config', 'commit.gpgsign', 'false']);
  if (options.install !== false) {
    const install = run('pnpm', ['run', '--silent', 'prepare']);
    assert.equal(install.status, 0, `husky install failed:\n${install.output}`);
  }
  gitOk(['add', '--all']);
  // The initial commit carries the whole fixture; it bypasses the hooks to keep setup fast.
  gitOk(['commit', '--quiet', '--no-verify', '-m', 'chore: initial fixture']);

  return {
    root,
    bin,
    run,
    git,
    write: (rel, text) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    },
    read: (rel) => readFileSync(path.join(root, rel), 'utf8'),
    head: () => gitOk(['rev-parse', 'HEAD']).trim(),
    committed: (rel) => gitOk(['show', `HEAD:${rel}`]),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Asserts a git command succeeded.
 * @param {RunResult} result
 * @param {string} what
 */
function assertOk(result, what) {
  assert.equal(result.status, 0, `${what} failed:\n${result.output}`);
}

describe('repository wiring', () => {
  it('installs Husky from the root prepare script', () => {
    const scripts = asObject(readJsonObject(path.join(REPO_ROOT, 'package.json')).scripts);
    assert.equal(scripts.prepare, 'husky');
  });

  it('wires each hook to its tool', () => {
    const hook = (/** @type {string} */ name) =>
      readFileSync(path.join(REPO_ROOT, '.husky', name), 'utf8');
    assert.match(hook('pre-commit'), /^lint-staged$/m);
    assert.match(hook('pre-commit'), /gitleaks protect --staged/);
    assert.match(hook('commit-msg'), /^commitlint --edit "\$1"$/m);
    assert.match(hook('pre-push'), /^pnpm typecheck$/m);
    // Husky v9 hooks are plain scripts: no deprecated `husky.sh` sourcing.
    for (const name of ['pre-commit', 'commit-msg', 'pre-push']) {
      assert.doesNotMatch(hook(name), /husky\.sh/);
    }
  });

  it('formats and lints TypeScript, and formats Go, in lint-staged', () => {
    const config = asObject(lintStaged);
    const ts = Object.entries(config).find(([glob]) => /\bts\b/.test(glob));
    assert.ok(ts, 'no lint-staged entry for *.ts');
    assert.deepEqual(ts[1], [
      'eslint --fix --max-warnings=0 --no-warn-ignored',
      'prettier --write --ignore-unknown',
    ]);
    assert.equal(config['*.go'], 'gofmt -w');
  });

  it('enforces LF line endings for every text file', () => {
    const result = spawnSync(
      'git',
      ['check-attr', 'text', 'eol', '--', 'packages/x/src/a.ts', 'apps/egress-gateway/main.go'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /packages\/x\/src\/a\.ts: text: auto/);
    assert.match(result.stdout, /packages\/x\/src\/a\.ts: eol: lf/);
    assert.match(result.stdout, /apps\/egress-gateway\/main\.go: eol: lf/);
  });
});

describe('Husky install (prepare)', () => {
  it('points core.hooksPath at .husky/_ and generates the hook shims', () => {
    const repo = makeHookRepo();
    try {
      assert.equal(repo.git(['config', 'core.hooksPath']).stdout.trim(), '.husky/_');
      for (const name of ['pre-commit', 'commit-msg', 'pre-push']) {
        assert.ok(existsSync(path.join(repo.root, '.husky', '_', name)), `${name} shim missing`);
      }
    } finally {
      repo.cleanup();
    }
  });

  it('skips the install when HUSKY=0 (CI)', () => {
    const repo = makeHookRepo({ install: false });
    try {
      const install = repo.run('pnpm', ['run', '--silent', 'prepare'], { HUSKY: '0' });
      assertOk(install, 'prepare with HUSKY=0');
      assert.match(install.output, /HUSKY=0 skip install/);
      assert.notEqual(repo.git(['config', 'core.hooksPath']).status, 0);
      assert.ok(!existsSync(path.join(repo.root, '.husky', '_')));
    } finally {
      repo.cleanup();
    }
  });
});

describe('commit-msg hook (commitlint)', () => {
  /** @type {HookRepo} */
  let repo;
  before(() => {
    repo = makeHookRepo();
  });
  after(() => {
    repo.cleanup();
  });

  it('rejects the commit message "bad message"', () => {
    const before = repo.head();
    repo.write('notes.txt', 'one\n');
    assertOk(repo.git(['add', 'notes.txt']), 'git add');
    const result = repo.git(['commit', '-m', 'bad message']);
    assert.notEqual(result.status, 0, 'commit should have been rejected');
    assert.match(result.output, /type may not be empty/);
    assert.match(result.output, /subject may not be empty/);
    assert.equal(repo.head(), before, 'no commit may be created');
  });

  it('accepts "feat(egress): add budget"', () => {
    const result = repo.git(['commit', '-m', 'feat(egress): add budget']);
    assertOk(result, 'commit');
    assert.equal(repo.git(['log', '-1', '--format=%s']).stdout.trim(), 'feat(egress): add budget');
  });

  it('rejects an unknown scope', () => {
    repo.write('notes.txt', 'two\n');
    assertOk(repo.git(['add', 'notes.txt']), 'git add');
    const result = repo.git(['commit', '-m', 'feat(payments): add checkout']);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /scope-enum/);
  });

  it('exempts the merge commit message git writes itself', () => {
    assertOk(repo.git(['commit', '-m', 'docs: note two']), 'commit');
    assertOk(repo.git(['switch', '--quiet', '-c', 'side']), 'switch');
    repo.write('side.txt', 'side\n');
    assertOk(repo.git(['add', 'side.txt']), 'git add');
    assertOk(repo.git(['commit', '-m', 'docs: add a side note']), 'commit on side');
    assertOk(repo.git(['switch', '--quiet', 'main']), 'switch back');
    repo.write('main.txt', 'main\n');
    assertOk(repo.git(['add', 'main.txt']), 'git add');
    assertOk(repo.git(['commit', '-m', 'docs: add a main note']), 'commit on main');

    const merge = repo.git(['merge', '--no-ff', '--no-edit', 'side']);
    assertOk(merge, 'merge with the default message');
    assert.equal(repo.git(['log', '-1', '--format=%s']).stdout.trim(), "Merge branch 'side'");
  });

  it('still lints a merge commit with a hand-written message', () => {
    assertOk(repo.git(['switch', '--quiet', '-c', 'other']), 'switch');
    repo.write('other.txt', 'other\n');
    assertOk(repo.git(['add', 'other.txt']), 'git add');
    assertOk(repo.git(['commit', '-m', 'docs: add another note']), 'commit');
    assertOk(repo.git(['switch', '--quiet', 'main']), 'switch back');
    const before = repo.head();
    const merge = repo.git(['merge', '--no-ff', '-m', 'merging stuff', 'other']);
    assert.notEqual(merge.status, 0, 'merge should have been rejected');
    assert.equal(repo.head(), before);
    assertOk(repo.git(['merge', '--abort']), 'merge --abort');
  });

  it("accepts git's revert message and a conventional revert", () => {
    repo.write('revert-me.txt', 'oops\n');
    assertOk(repo.git(['add', 'revert-me.txt']), 'git add');
    assertOk(repo.git(['commit', '-m', 'docs: add a note to revert']), 'commit');
    assertOk(repo.git(['revert', '--no-edit', 'HEAD']), 'git revert');
    assert.match(repo.git(['log', '-1', '--format=%s']).stdout, /^Revert "/);
    assertOk(repo.git(['revert', '--no-edit', 'HEAD']), 'git revert of the revert');
    repo.write('notes.txt', 'three\n');
    assertOk(repo.git(['add', 'notes.txt']), 'git add');
    assertOk(repo.git(['commit', '-m', 'revert: docs: note two']), 'conventional revert');
  });

  it('runs no hook when HUSKY=0 (CI)', () => {
    repo.write('notes.txt', 'four\n');
    assertOk(repo.git(['add', 'notes.txt']), 'git add');
    assertOk(repo.git(['commit', '-m', 'bad message'], { HUSKY: '0' }), 'commit with HUSKY=0');
    assert.equal(repo.git(['log', '-1', '--format=%s']).stdout.trim(), 'bad message');
  });
});

describe('pre-commit hook (lint-staged + gitleaks)', () => {
  /** @type {HookRepo} */
  let repo;
  before(() => {
    repo = makeHookRepo();
  });
  after(() => {
    repo.cleanup();
  });

  const file = `${DEMO}/src/index.ts`;

  it('auto-formats and lint-fixes a staged .ts file', () => {
    repo.write(file, 'let  value = {a:1,b:"two"}\nexport const name = value\n');
    assertOk(repo.git(['add', file]), 'git add');
    assertOk(repo.git(['commit', '-m', 'feat(demo): add a value']), 'commit');
    const expected = "const value = { a: 1, b: 'two' };\nexport const name = value;\n";
    assert.equal(repo.committed(file), expected, 'committed content is formatted');
    assert.equal(repo.read(file), expected, 'working copy is formatted');
  });

  it('blocks the commit on a lint error it cannot fix', () => {
    const before = repo.head();
    repo.write(file, 'export const name: any = 1;\n');
    assertOk(repo.git(['add', file]), 'git add');
    const result = repo.git(['commit', '-m', 'feat(demo): loosen a type']);
    assert.notEqual(result.status, 0, 'commit should have been rejected');
    assert.match(result.output, /no-explicit-any/);
    assert.equal(repo.head(), before);
    assertOk(repo.git(['checkout', 'HEAD', '--', file]), 'restore');
  });

  it('touches only staged files', () => {
    const unstaged = `${DEMO}/src/unstaged.ts`;
    const untracked = `${DEMO}/src/untracked.ts`;
    const messy = 'export const  messy = {a:1}\n';
    repo.write(unstaged, "export const unstaged = 'clean';\n");
    assertOk(repo.git(['add', unstaged]), 'git add');
    assertOk(repo.git(['commit', '-m', 'feat(demo): add unstaged']), 'commit');

    repo.write(unstaged, messy);
    repo.write(untracked, messy);
    repo.write(file, 'export const name   = "demo"\n');
    assertOk(repo.git(['add', file]), 'git add');

    assertOk(repo.git(['commit', '-m', 'fix(demo): format the name']), 'commit');
    assert.equal(repo.committed(file), "export const name = 'demo';\n");
    assert.equal(repo.read(unstaged), messy, 'an unstaged edit stays untouched');
    assert.equal(repo.read(untracked), messy, 'an untracked file stays untouched');
    assert.equal(repo.committed(unstaged), "export const unstaged = 'clean';\n");
  });

  it('formats a staged .go file with gofmt', () => {
    const go = 'apps/egress-gateway/main.go';
    repo.write(go, 'package main\nfunc main( ) {\nprintln( "hi" )\n}\n');
    assertOk(repo.git(['add', go]), 'git add');
    assertOk(repo.git(['commit', '-m', 'feat(egress): add main']), 'commit');
    assert.equal(repo.committed(go), 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n');
  });

  it('scans the staged changes with gitleaks and blocks the commit on a finding', () => {
    const calls = path.join(repo.bin, 'gitleaks.calls');
    assert.match(
      readFileSync(calls, 'utf8'),
      /^protect --staged --redact --no-banner --config \.gitleaks\.toml$/m,
    );
    fakeGitleaks(repo.bin, 1);
    const before = repo.head();
    repo.write('notes.txt', 'pretend secret\n');
    assertOk(repo.git(['add', 'notes.txt']), 'git add');
    const result = repo.git(['commit', '-m', 'docs: add notes']);
    assert.notEqual(result.status, 0, 'commit should have been rejected');
    assert.equal(repo.head(), before);
    fakeGitleaks(repo.bin, 0);
  });

  it('normalises CRLF to LF in the repository (.gitattributes)', () => {
    repo.write('crlf.txt', 'one\r\ntwo\r\n');
    assertOk(repo.git(['add', 'crlf.txt']), 'git add');
    assertOk(repo.git(['commit', '-m', 'docs: add crlf']), 'commit');
    assert.equal(repo.committed('crlf.txt'), 'one\ntwo\n');
  });
});

describe('pre-push hook (pnpm typecheck)', () => {
  /**
   * @param {string} typecheck
   */
  function repoWithRemote(typecheck) {
    const repo = makeHookRepo({ typecheck });
    const remote = path.join(repo.root, '..', 'remote.git');
    assertOk(repo.git(['init', '--quiet', '--bare', remote]), 'init bare remote');
    assertOk(repo.git(['remote', 'add', 'origin', remote]), 'remote add');
    return { repo, remote };
  }

  it('pushes when the typecheck passes', () => {
    const marker = 'typecheck-ran';
    const { repo, remote } = repoWithRemote(
      `node -e "require('node:fs').writeFileSync('${marker}', '')"`,
    );
    try {
      assertOk(repo.git(['push', '--quiet', 'origin', 'main']), 'push');
      assert.ok(existsSync(path.join(repo.root, marker)), 'pre-push did not run pnpm typecheck');
      const remoteHead = repo.git(['--git-dir', remote, 'rev-parse', 'main']).stdout.trim();
      assert.equal(remoteHead, repo.head());
    } finally {
      repo.cleanup();
    }
  });

  it('aborts the push when the typecheck fails', () => {
    const { repo, remote } = repoWithRemote('node -e "process.exit(3)"');
    try {
      const result = repo.git(['push', 'origin', 'main']);
      assert.notEqual(result.status, 0, 'push should have been aborted');
      assert.match(result.output, /pre-push script failed/);
      assert.notEqual(repo.git(['--git-dir', remote, 'rev-parse', '--verify', 'main']).status, 0);
    } finally {
      repo.cleanup();
    }
  });
});
