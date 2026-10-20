// Tests for the Turborepo task pipeline (FOUND-002): the static contract checks in
// check-turbo.mjs, the real turbo.json of this repository, and end-to-end behaviour of the
// real turbo binary on a temporary fixture workspace that uses this repository's turbo.json
// verbatim (topological builds, cache hits, cache busting, uncached IO tasks, missing
// outputs, run summaries, no remote cache).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  CACHED_TASKS,
  REQUIRED_TASKS,
  ROOT_TURBO_SCRIPTS,
  UNCACHED_TASKS,
  checkGitignore,
  checkPackageConfigs,
  checkRootScripts,
  checkRunSummary,
  checkTurbo,
  checkTurboConfig,
  latestSummary,
  listMembers,
  main,
} from './check-turbo.mjs';
import {
  REPO_ROOT,
  SCRIPTS_DIR,
  asArray,
  asObject,
  cleanEnv,
  defined,
  parseJsonObject,
  readJsonObject,
  writeJson,
} from './test-fixtures.mjs';

/** @typedef {import("./test-fixtures.mjs").JsonObject} JsonObject */

const TURBO_BIN = path.join(REPO_ROOT, 'node_modules', 'turbo', 'bin', 'turbo');
const SNAPSHOT = path.join(SCRIPTS_DIR, 'fixtures', 'turbo-build-dry.snapshot.json');
const UPDATE_SNAPSHOTS = process.env.BW_UPDATE_SNAPSHOTS === '1';

/** @returns {JsonObject} */
function realConfig() {
  return readJsonObject(path.join(REPO_ROOT, 'turbo.json'));
}

/** @returns {JsonObject} */
function realManifest() {
  return readJsonObject(path.join(REPO_ROOT, 'package.json'));
}

/**
 * The fields of a turbo `--dry=json` / `--summarize` task entry that these tests read.
 * @typedef {{
 *   taskId: string, task: string, package: string, hash: string, command: string, inputs: Record<string, string>,
 *   dependencies: string[], dependents: string[], outputs: string[], expandedOutputs?: string[],
 *   cache: { status: string, remote: boolean },
 *   resolvedTaskDefinition: {
 *     dependsOn: string[], inputs: string[], outputs: string[], cache: boolean, persistent: boolean,
 *   },
 * }} TurboTask
 */

/**
 * A mutable turbo.json draft (shape of this repository's config).
 * @typedef {{ [key: string]: unknown, tasks: Record<string, JsonObject>, remoteCache: JsonObject }} TurboConfigDraft
 */

/**
 * One task of a turbo.json draft, failing the test when the config does not define it.
 * @param {TurboConfigDraft} config
 * @param {string} name
 * @returns {JsonObject}
 */
function taskOf(config, name) {
  return defined(config.tasks[name], `turbo.json task "${name}"`);
}

/**
 * Parses turbo's `--dry=json` / `--summarize` JSON, checking the `tasks` array these tests read.
 * @param {string} text
 * @returns {{ tasks: TurboTask[] }}
 */
function parseTurboTasks(text) {
  const graph = parseJsonObject(text, 'turbo task graph');
  asArray(graph.tasks, 'turbo task graph tasks');
  return /** @type {{ tasks: TurboTask[] }} */ (graph);
}

/**
 * Deep copy of the real turbo.json with a mutation applied.
 * @param {(config: TurboConfigDraft) => void} mutate
 * @returns {Record<string, unknown>}
 */
function mutatedConfig(mutate) {
  const config = /** @type {TurboConfigDraft} */ (structuredClone(realConfig()));
  mutate(config);
  return config;
}

/**
 * @param {string[]} errors
 * @param {RegExp} pattern
 */
function assertError(errors, pattern) {
  assert.ok(
    errors.some((e) => pattern.test(e)),
    `expected an error matching ${pattern}, got:\n${errors.join('\n') || '(none)'}`,
  );
}

/**
 * Environment for a nested turbo: no inherited npm/pnpm/turbo settings (a parent
 * `turbo run` exports TURBO_* variables), no telemetry, no colours.
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
function turboEnv(extra = {}) {
  const env = cleanEnv();
  for (const key of Object.keys(env)) {
    if (/^TURBO_/i.test(key)) Reflect.deleteProperty(env, key);
  }
  return {
    ...env,
    TURBO_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...extra,
  };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {{ status: number | null, stdout: string, stderr: string, output: string }}
 */
function turbo(cwd, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [TURBO_BIN, ...args], {
    cwd,
    env: turboEnv(extraEnv),
    encoding: 'utf8',
    timeout: 180_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

/**
 * Runs turbo and returns the parsed `--dry=json` graph.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ tasks: TurboTask[] }}
 */
function dryRun(cwd, args) {
  const result = turbo(cwd, ['run', ...args, '--dry=json']);
  assert.equal(result.status, 0, result.output);
  return parseTurboTasks(result.stdout);
}

// ---------------------------------------------------------------------------------------
// Static contract
// ---------------------------------------------------------------------------------------

describe('check-turbo against this repository', () => {
  it('passes every static check', () => {
    const result = checkTurbo(REPO_ROOT);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it('uses the Turborepo v2 `tasks` key and defines every workspace task', () => {
    const config = realConfig();
    assert.equal('pipeline' in config, false);
    assert.deepEqual(
      Object.keys(/** @type {object} */ (config.tasks))
        .filter((t) => !t.startsWith('//#'))
        .sort(),
      [...REQUIRED_TASKS].sort(),
    );
  });

  it('wires the agreed root scripts verbatim', () => {
    const scripts = /** @type {Record<string, string>} */ (realManifest().scripts);
    assert.deepEqual(ROOT_TURBO_SCRIPTS, {
      build: 'turbo run build',
      lint: 'turbo run lint',
      typecheck: 'turbo run typecheck',
      test: 'turbo run test',
      'test:int': 'turbo run test:int',
      'test:e2e': 'turbo run test:e2e',
      dev: 'node scripts/dev-doctor.mjs && turbo run dev --parallel',
    });
    for (const [name, command] of Object.entries(ROOT_TURBO_SCRIPTS))
      assert.equal(scripts[name], command);
    assert.equal(scripts['test:scripts'], 'node --test "scripts/**/*.test.mjs"');
  });

  it('pins the turbo devDependency to the installed version', () => {
    const pinned = /** @type {Record<string, string>} */ (realManifest().devDependencies).turbo;
    const installed = readJsonObject(
      path.join(REPO_ROOT, 'node_modules', 'turbo', 'package.json'),
    ).version;
    assert.equal(pinned, installed);
  });

  it('keeps the local cache, logs and run summaries out of git', () => {
    assert.deepEqual(checkGitignore(readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')), []);
  });

  it('runs the scripts/ self-tests as part of `turbo run test`, uncached', () => {
    const tasks = /** @type {Record<string, { dependsOn?: string[], cache?: boolean }>} */ (
      realConfig().tasks
    );
    assert.ok(tasks.test?.dependsOn?.includes('//#test:scripts'));
    assert.equal(tasks['//#test:scripts']?.cache, false);
  });

  it('CLI exits 0 on this repository and prints a JSON result', () => {
    const result = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'check-turbo.mjs')], {
      encoding: 'utf8',
      env: turboEnv(),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseJsonObject(result.stdout).ok, true);
  });
});

describe('checkTurboConfig rejects unsafe pipelines', () => {
  it('rejects the v1 `pipeline` key', () => {
    const errors = checkTurboConfig(
      mutatedConfig((c) => {
        c.pipeline = c.tasks;
        Reflect.deleteProperty(c, 'tasks');
      }),
    );
    assertError(errors, /v1 "pipeline" key/);
    assertError(errors, /"tasks" must be an object/);
  });

  for (const task of REQUIRED_TASKS) {
    it(`rejects a pipeline without "${task}"`, () => {
      assertError(
        checkTurboConfig(mutatedConfig((c) => Reflect.deleteProperty(c.tasks, task))),
        new RegExp(`task "${task}" is missing`),
      );
    });
  }

  for (const task of UNCACHED_TASKS) {
    it(`rejects caching "${task}" (over-caching IO-heavy or persistent tasks)`, () => {
      assertError(
        checkTurboConfig(mutatedConfig((c) => delete taskOf(c, task).cache)),
        new RegExp(`"${task}" must set "cache": false`),
      );
    });
  }

  for (const task of CACHED_TASKS) {
    it(`rejects disabling the cache for "${task}"`, () => {
      assertError(
        checkTurboConfig(mutatedConfig((c) => (taskOf(c, task).cache = false))),
        new RegExp(`"${task}" must be cacheable`),
      );
    });

    for (const input of ['src/**', 'tsconfig*.json', 'package.json']) {
      it(`rejects "${task}" inputs without ${input}`, () => {
        const errors = checkTurboConfig(
          mutatedConfig((c) => {
            taskOf(c, task).inputs = asArray(taskOf(c, task).inputs).filter((i) => i !== input);
          }),
        );
        assertError(
          errors,
          new RegExp(`"${task}" inputs must include "${input.replace(/[*.]/g, '\\$&')}"`),
        );
      });
    }

    it(`requires "${task}" to declare outputs explicitly`, () => {
      assertError(
        checkTurboConfig(mutatedConfig((c) => delete taskOf(c, task).outputs)),
        new RegExp(`"${task}" must declare "outputs" explicitly`),
      );
    });
  }

  it('requires build to depend on ^build and output dist/**', () => {
    const errors = checkTurboConfig(
      mutatedConfig((c) => {
        taskOf(c, 'build').dependsOn = [];
        taskOf(c, 'build').outputs = ['lib/**'];
      }),
    );
    assertError(errors, /"build" must depend on "\^build"/);
    assertError(errors, /"build" must declare "dist\/\*\*"/);
  });

  it('requires typecheck to depend on ^build and ^typecheck and declare no outputs', () => {
    const errors = checkTurboConfig(
      mutatedConfig((c) => {
        taskOf(c, 'typecheck').dependsOn = [];
        taskOf(c, 'typecheck').outputs = ['dist/**'];
      }),
    );
    assertError(errors, /"typecheck" must depend on "\^build"/);
    assertError(errors, /"typecheck" must depend on "\^typecheck"/);
    assertError(errors, /"typecheck" must declare no outputs/);
  });

  it('rejects dependencies on undefined root tasks and root tasks hashing every root file', () => {
    const errors = checkTurboConfig(
      mutatedConfig((c) => {
        taskOf(c, 'lint').dependsOn = ['^build', '//#nope'];
        taskOf(c, '//#test:scripts').inputs = ['$TURBO_DEFAULT$'];
        delete taskOf(c, '//#check:tsconfig').inputs;
      }),
    );
    assertError(errors, /"lint" depends on undefined root task "\/\/#nope"/);
    assertError(
      errors,
      /root task "\/\/#test:scripts" \(a dependency of "test"\) must declare explicit "inputs"/,
    );
    assertError(
      errors,
      /root task "\/\/#check:tsconfig" \(a dependency of "typecheck"\) must declare explicit "inputs"/,
    );
  });

  it('requires test to output coverage/**', () => {
    assertError(
      checkTurboConfig(mutatedConfig((c) => (taskOf(c, 'test').outputs = []))),
      /"test" must declare "coverage\/\*\*"/,
    );
  });

  it('requires dev to be persistent', () => {
    assertError(
      checkTurboConfig(mutatedConfig((c) => delete taskOf(c, 'dev').persistent)),
      /"dev" must set "persistent": true/,
    );
  });

  it('rejects outputs on uncached tasks and cached persistent tasks', () => {
    const errors = checkTurboConfig(
      mutatedConfig((c) => {
        taskOf(c, 'test:int').outputs = ['reports/**'];
        c.tasks.watch = { persistent: true };
      }),
    );
    assertError(errors, /"test:int" has "cache": false but declares outputs/);
    assertError(errors, /persistent task "watch" must set "cache": false/);
  });

  it('requires the base tsconfig and the ESLint config to bust every cache (stale cache)', () => {
    const errors = checkTurboConfig(
      mutatedConfig((c) => {
        c.globalDependencies = ['.nvmrc'];
      }),
    );
    assertError(errors, /"globalDependencies" must include "tsconfig\.base\.json"/);
    assertError(errors, /"globalDependencies" must include the ESLint config/);
  });

  it('rejects an enabled or unspecified remote cache', () => {
    assertError(
      checkTurboConfig(mutatedConfig((c) => (c.remoteCache.enabled = true))),
      /"remoteCache\.enabled" must be false/,
    );
    assertError(
      checkTurboConfig(mutatedConfig((c) => Reflect.deleteProperty(c, 'remoteCache'))),
      /"remoteCache\.enabled" must be false/,
    );
  });

  it('rejects agent guidance files, loose env mode and a root `extends`', () => {
    const errors = checkTurboConfig(
      mutatedConfig((c) => {
        delete c.agentGuidance;
        c.envMode = 'loose';
        c.extends = ['//'];
      }),
    );
    assertError(errors, /"agentGuidance" must be false/);
    assertError(errors, /"envMode" must be "strict"/);
    assertError(errors, /"extends" is only valid in package-level/);
  });
});

describe('checkRootScripts / checkGitignore / checkPackageConfigs', () => {
  it('rejects root scripts that bypass turbo', () => {
    const manifest = structuredClone(realManifest());
    /** @type {Record<string, string>} */ (manifest.scripts).test = 'pnpm -r test';
    delete (/** @type {Record<string, string>} */ (manifest.scripts).dev);
    const errors = checkRootScripts(manifest);
    assertError(errors, /"scripts\.test" must be "turbo run test"/);
    assertError(
      errors,
      /"scripts\.dev" must be "node scripts\/dev-doctor\.mjs && turbo run dev --parallel"/,
    );
  });

  it('requires an exact turbo 2.x pin', () => {
    for (const turboVersion of ['^2.11.7', 'latest', '1.13.4', undefined]) {
      const manifest = structuredClone(realManifest());
      const devDeps = /** @type {Record<string, string | undefined>} */ (manifest.devDependencies);
      devDeps.turbo = turboVersion;
      assertError(checkRootScripts(manifest), /exact Turborepo 2\.x version/);
    }
  });

  it('accepts the usual .turbo ignore spellings and rejects their absence', () => {
    for (const line of ['.turbo', '.turbo/', '/.turbo/', '**/.turbo'])
      assert.deepEqual(checkGitignore(`node_modules/\n${line}\n`), []);
    assertError(checkGitignore('node_modules/\ndist/\n'), /must ignore "\.turbo\/"/);
  });

  it('requires package-level turbo.json files to extend the root config', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bw-turbo-pkg-'));
    try {
      writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
      writeJson(path.join(root, 'packages', 'ok', 'package.json'), { name: 'ok' });
      writeJson(path.join(root, 'packages', 'ok', 'turbo.json'), {
        extends: ['//'],
        tasks: { build: { outputs: [] } },
      });
      writeJson(path.join(root, 'packages', 'bad', 'package.json'), { name: 'bad' });
      writeJson(path.join(root, 'packages', 'bad', 'turbo.json'), { pipeline: {} });
      writeJson(path.join(root, 'packages', 'broken', 'package.json'), { name: 'broken' });
      writeFileSync(path.join(root, 'packages', 'broken', 'turbo.json'), '{ nope');
      assert.deepEqual(listMembers(root), ['packages/bad', 'packages/broken', 'packages/ok']);
      const errors = checkPackageConfigs(root);
      assert.equal(errors.length, 3, errors.join('\n'));
      assertError(errors, /packages\/bad\/turbo\.json: must contain "extends": \["\/\/"\]/);
      assertError(errors, /packages\/bad\/turbo\.json: uses the v1 "pipeline" key/);
      assertError(errors, /packages\/broken\/turbo\.json: invalid JSON/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkRunSummary (missing build outputs)', () => {
  /**
   * @param {Partial<Record<string, unknown>>} overrides
   * @returns {Record<string, unknown>}
   */
  const task = (overrides) => ({
    taskId: 'pkg#build',
    task: 'build',
    directory: 'packages/pkg',
    command: 'tsc -b',
    outputs: ['dist/**'],
    expandedOutputs: ['packages/pkg/.turbo/turbo-build.log'],
    cache: { status: 'MISS' },
    resolvedTaskDefinition: { cache: true, outputs: ['dist/**'] },
    execution: { exitCode: 0 },
    ...overrides,
  });

  it('reports a task that declares dist/** but produced nothing (only its log)', () => {
    const errors = checkRunSummary({ tasks: [task({})] });
    assert.equal(errors.length, 1);
    assertError(
      errors,
      /pkg#build: declares outputs \[dist\/\*\*\] but produced no matching files/,
    );
    assertError(errors, /declare "outputs": \[\] for "build" in packages\/pkg\/turbo\.json/);
  });

  it('reports an empty cache hit too (it would restore nothing)', () => {
    assertError(
      checkRunSummary({ tasks: [task({ cache: { status: 'HIT' } })] }),
      /cache status HIT/,
    );
  });

  it('accepts tasks that produced outputs, declare none, are uncached, failed or have no script', () => {
    const errors = checkRunSummary({
      tasks: [
        task({
          expandedOutputs: ['packages/pkg/.turbo/turbo-build.log', 'packages/pkg/dist/index.js'],
        }),
        task({
          taskId: 'none#build',
          outputs: [],
          resolvedTaskDefinition: { cache: true, outputs: [] },
        }),
        task({
          taskId: 'nocache#build',
          resolvedTaskDefinition: { cache: false, outputs: ['dist/**'] },
        }),
        task({ taskId: 'failed#build', execution: { exitCode: 1 } }),
        task({ taskId: 'missing#build', command: '<NONEXISTENT>' }),
        task({ taskId: 'pkg#test', task: 'test', outputs: ['coverage/**'] }),
      ],
    });
    assert.deepEqual(errors, []);
  });

  it('checks other tasks on request and rejects malformed summaries', () => {
    assertError(
      checkRunSummary(
        { tasks: [task({ taskId: 'pkg#test', task: 'test', outputs: ['coverage/**'] })] },
        ['test'],
      ),
      /pkg#test/,
    );
    assertError(checkRunSummary({}), /missing "tasks" array/);
  });

  it('CLI rejects conflicting or incomplete arguments', () => {
    assert.equal(main(['--summary', 'a.json', '--latest-summary', '--quiet']), 2);
    assert.equal(main(['--root']), 2);
    assert.equal(main(['--bogus']), 2);
    const empty = mkdtempSync(path.join(tmpdir(), 'bw-turbo-empty-'));
    try {
      assert.equal(latestSummary(empty), null);
      assert.equal(main(['--root', empty, '--latest-summary', '--quiet']), 2);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------
// The real repository graph
// ---------------------------------------------------------------------------------------

describe('turbo --dry=json on this repository', () => {
  /**
   * Workspace dependencies of each member, read independently of turbo.
   * @returns {Map<string, string[]>}
   */
  function workspaceDeps() {
    /** @type {Map<string, string[]>} */
    const deps = new Map();
    for (const dir of listMembers(REPO_ROOT)) {
      const manifest = readJsonObject(path.join(REPO_ROOT, dir, 'package.json'));
      assert.ok(typeof manifest.name === 'string', `${dir}/package.json name`);
      /** @type {JsonObject} */
      const all = {};
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        if (manifest[field] !== undefined)
          Object.assign(all, asObject(manifest[field], `${dir} ${field}`));
      }
      deps.set(
        manifest.name,
        Object.entries(all)
          .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('workspace:'))
          .map(([name]) => name)
          .sort(),
      );
    }
    return deps;
  }

  /** @type {Record<string, (deps: string[]) => string[]>} */
  const expectedEdges = {
    build: (deps) => deps.map((name) => `${name}#build`),
    typecheck: (deps) => [
      '//#check:tsconfig',
      ...deps.flatMap((name) => [`${name}#build`, `${name}#typecheck`]),
    ],
  };

  for (const [taskName, expectedFor] of Object.entries(expectedEdges)) {
    it(`${taskName}: every package depends exactly on its workspace dependencies (^build edges)`, () => {
      const deps = workspaceDeps();
      const graph = dryRun(REPO_ROOT, [taskName]);
      const own = graph.tasks.filter((t) => t.task === taskName);
      assert.equal(own.length, deps.size, 'one task per workspace member');
      for (const t of own) {
        assert.ok(
          t.resolvedTaskDefinition.dependsOn.includes('^build'),
          `${t.taskId} dependsOn ^build`,
        );
        const expected = expectedFor(deps.get(t.package) ?? []).sort();
        assert.deepEqual([...t.dependencies].sort(), expected, `${t.taskId} dependencies`);
        assert.equal(t.cache.remote, false);
      }
    });
  }

  it('typecheck hashes every file tsc -b reads, including nested projects outside src/', () => {
    const testing = dryRun(REPO_ROOT, ['typecheck', '--filter=@blackwing/testing']).tasks.find(
      (t) => t.taskId === '@blackwing/testing#typecheck',
    );
    assert.ok(testing, '@blackwing/testing#typecheck is in the graph');
    const inputs = Object.keys(testing.inputs);
    assert.ok(inputs.includes('typefixtures/tsconfig.json'), inputs.join(', '));
    assert.ok(inputs.some((file) => file.startsWith('src/')));
    assert.ok(
      !inputs.some(
        (file) =>
          file.startsWith('dist/') ||
          file.startsWith('node_modules/') ||
          file.startsWith('.turbo/'),
      ),
    );
  });

  it('the tsconfig structure check hashes every member tsconfig and manifest', () => {
    const check = dryRun(REPO_ROOT, ['check:tsconfig']).tasks.find(
      (t) => t.taskId === '//#check:tsconfig',
    );
    assert.ok(check, '//#check:tsconfig is in the graph');
    const inputs = Object.keys(check.inputs);
    for (const dir of listMembers(REPO_ROOT)) {
      assert.ok(inputs.includes(`${dir}/package.json`), `${dir}/package.json`);
      if (existsSync(path.join(REPO_ROOT, dir, 'tsconfig.json')))
        assert.ok(inputs.includes(`${dir}/tsconfig.json`), `${dir}/tsconfig.json`);
    }
    for (const file of ['scripts/check-tsconfig.mjs', 'tsconfig.base.json', 'tsconfig.json'])
      assert.ok(inputs.includes(file), file);
    assert.ok(!inputs.some((file) => file.includes('node_modules/') || file.includes('/dist/')));
  });
});

// ---------------------------------------------------------------------------------------
// End-to-end behaviour on a fixture workspace
// ---------------------------------------------------------------------------------------

const TASK_RUNNER = `// Fixture task: logs "<package> <task>" and, with --emit, writes dist/index.js.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [task, ...flags] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync("package.json", "utf8")).name;
appendFileSync(path.join(root, "task-log.txt"), pkg + " " + task + "\\n");
if (flags.includes("--emit")) {
  mkdirSync("dist", { recursive: true });
  writeFileSync("dist/index.js", "export const name = " + JSON.stringify(pkg) + ";\\n");
}
`;

/**
 * Fixture: packages a <- b <- c (c depends on b, b on a) and d (independent, its build
 * emits nothing and therefore declares `"outputs": []` in its own turbo.json), using this
 * repository's turbo.json unchanged.
 * @returns {string} the fixture root
 */
function makeTurboFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-turbo-'));
  writeFileSync(path.join(root, 'turbo.json'), readFileSync(path.join(REPO_ROOT, 'turbo.json')));
  writeJson(path.join(root, 'package.json'), {
    name: 'fixture-root',
    version: '0.0.0',
    private: true,
    packageManager: 'pnpm@9.15.0',
    scripts: {
      'test:scripts': 'node tools/task.mjs test:scripts',
      'check:tsconfig': 'node tools/task.mjs check:tsconfig',
    },
  });
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  writeJson(path.join(root, 'tsconfig.base.json'), { compilerOptions: { strict: true } });
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.turbo/\ndist/\n');
  mkdirSync(path.join(root, 'tools'));
  writeFileSync(path.join(root, 'tools', 'task.mjs'), TASK_RUNNER);

  const run = (/** @type {string} */ task, emit = false) =>
    `node ../../tools/task.mjs ${task}${emit ? ' --emit' : ''}`;
  /** @type {Array<[string, string[], boolean]>} */
  const packages = [
    ['a', [], true],
    ['b', ['a'], true],
    ['c', ['b'], true],
    ['d', [], false],
  ];
  for (const [name, deps, emits] of packages) {
    const dir = path.join(root, 'packages', name);
    writeJson(path.join(dir, 'package.json'), {
      name,
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
      scripts: {
        build: run('build', emits),
        // Like `tsc -b`, typecheck emits into dist/ (which must not become one of its inputs).
        typecheck: run('typecheck', emits),
        lint: run('lint'),
        test: run('test'),
        'test:int': run('test:int'),
        'test:e2e': run('test:e2e'),
        dev: run('dev'),
      },
    });
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'index.ts'), `export const name = "${name}";\n`);
    writeFileSync(path.join(dir, 'src', 'index.test.ts'), `// test for ${name}\n`);
    writeJson(path.join(dir, 'tsconfig.json'), { extends: '../../tsconfig.base.json' });
    if (!emits)
      writeJson(path.join(dir, 'turbo.json'), {
        extends: ['//'],
        tasks: { build: { outputs: [] } },
      });
  }

  // Workspace-only dependencies: the install is offline and produces a real lockfile.
  const install = spawnSync('pnpm', ['install', '--offline', '--ignore-scripts'], {
    cwd: root,
    env: turboEnv(),
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  return root;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function readTaskLog(root) {
  const file = path.join(root, 'task-log.txt');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

/**
 * @param {string} root
 */
function resetTaskLog(root) {
  rmSync(path.join(root, 'task-log.txt'), { force: true });
}

/**
 * Runs a task with --summarize and returns `taskId -> cache status`.
 * @param {string} root
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {{ statuses: Record<string, string>, output: string, summary: { tasks: TurboTask[] } }}
 */
function runSummarized(root, args, extraEnv = {}) {
  rmSync(path.join(root, '.turbo', 'runs'), { recursive: true, force: true });
  const result = turbo(root, ['run', ...args, '--summarize'], extraEnv);
  assert.equal(result.status, 0, result.output);
  const file = latestSummary(root);
  assert.ok(file !== null, 'turbo --summarize writes a run summary to .turbo/runs');
  const summary = parseTurboTasks(readFileSync(file, 'utf8'));
  /** @type {Record<string, string>} */
  const statuses = {};
  for (const task of summary.tasks) statuses[task.taskId] = task.cache.status;
  return { statuses, output: result.output, summary };
}

/**
 * Normalises a dry-run graph to the fields that define the pipeline (no hashes or paths).
 * @param {{ tasks: TurboTask[] }} graph
 */
function normaliseGraph(graph) {
  return graph.tasks
    .map((t) => ({
      taskId: t.taskId,
      command: t.command,
      dependencies: [...t.dependencies].sort(),
      dependents: [...t.dependents].sort(),
      dependsOn: [...t.resolvedTaskDefinition.dependsOn].sort(),
      inputs: [...t.resolvedTaskDefinition.inputs].sort(),
      outputs: [...t.resolvedTaskDefinition.outputs].sort(),
      cache: t.resolvedTaskDefinition.cache,
      persistent: t.resolvedTaskDefinition.persistent,
      remoteCache: t.cache.remote,
    }))
    .sort((x, y) => x.taskId.localeCompare(y.taskId));
}

/**
 * Task hashes from a dry run (`taskId -> hash`). A changed hash is a cache miss; this
 * checks cache busting without executing any task.
 * @param {string} root
 * @param {string[]} tasks
 * @returns {Record<string, string>}
 */
function taskHashes(root, tasks) {
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const t of dryRun(root, tasks).tasks) hashes[t.taskId] = t.hash;
  return hashes;
}

/**
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 * @returns {string[]} the task ids whose hash changed, sorted
 */
function changedTasks(before, after) {
  return Object.keys(after)
    .filter((id) => before[id] !== after[id])
    .sort();
}

describe('turbo pipeline on a fixture workspace', () => {
  /** @type {string} */
  let root;
  before(() => {
    root = makeTurboFixture();
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds every package in topological order and passes the output check', () => {
    resetTaskLog(root);
    const { summary, output } = runSummarized(root, ['build']);
    const builds = readTaskLog(root)
      .filter((line) => line.endsWith(' build'))
      .map((line) => line.split(' ')[0]);
    assert.deepEqual([...builds].sort(), ['a', 'b', 'c', 'd']);
    assert.ok(builds.indexOf('a') < builds.indexOf('b'), `a before b: ${builds.join(',')}`);
    assert.ok(builds.indexOf('b') < builds.indexOf('c'), `b before c: ${builds.join(',')}`);
    for (const name of ['a', 'b', 'c'])
      assert.ok(existsSync(path.join(root, 'packages', name, 'dist', 'index.js')));
    assert.equal(existsSync(path.join(root, 'packages', 'd', 'dist')), false);
    assert.doesNotMatch(output, /no output files found/);
    assert.deepEqual(checkRunSummary(summary), []);
    assert.equal(
      existsSync(path.join(root, 'AGENTS.md')),
      false,
      'turbo must not write agent guidance files',
    );
  });

  it('restores dist/** from the cache on a hit', () => {
    rmSync(path.join(root, 'packages', 'c', 'dist'), { recursive: true, force: true });
    const { statuses } = runSummarized(root, ['build', '--filter=c']);
    assert.equal(statuses['c#build'], 'HIT');
    assert.ok(existsSync(path.join(root, 'packages', 'c', 'dist', 'index.js')));
  });

  it('--dry=json shows the ^build edges (snapshot)', () => {
    const graph = normaliseGraph(dryRun(root, ['build']));
    const byId = Object.fromEntries(graph.map((t) => [t.taskId, t]));
    assert.deepEqual(defined(byId['a#build'], 'a#build').dependencies, []);
    assert.deepEqual(defined(byId['b#build'], 'b#build').dependencies, ['a#build']);
    assert.deepEqual(defined(byId['c#build'], 'c#build').dependencies, ['b#build']);
    assert.deepEqual(defined(byId['a#build'], 'a#build').dependents, ['b#build']);
    assert.deepEqual(
      defined(byId['d#build'], 'd#build').outputs,
      [],
      'package-level override for a build without dist/',
    );
    if (UPDATE_SNAPSHOTS) writeJson(SNAPSHOT, graph);
    assert.ok(
      existsSync(SNAPSHOT),
      `missing ${path.relative(REPO_ROOT, SNAPSHOT)}; run BW_UPDATE_SNAPSHOTS=1 pnpm test:scripts`,
    );
    assert.deepEqual(
      graph,
      JSON.parse(readFileSync(SNAPSHOT, 'utf8')),
      'turbo build graph changed; if intended, run BW_UPDATE_SNAPSHOTS=1 pnpm test:scripts and commit the snapshot',
    );
  });

  it('typecheck depends on upstream builds and a second run is FULL TURBO', () => {
    const c = defined(
      dryRun(root, ['typecheck']).tasks.find((t) => t.taskId === 'c#typecheck'),
      'c#typecheck',
    );
    assert.deepEqual([...c.dependencies].sort(), ['//#check:tsconfig', 'b#build', 'b#typecheck']);
    const first = turbo(root, ['run', 'typecheck']);
    assert.equal(first.status, 0, first.output);
    assert.doesNotMatch(first.output, /FULL TURBO/);
    const second = runSummarized(root, ['typecheck']);
    assert.match(second.output, /FULL TURBO/);
    for (const status of Object.values(second.statuses)) assert.equal(status, 'HIT');
  });

  it('a change to tsconfig.base.json busts every task (stale cache)', () => {
    const tasks = ['build', 'typecheck', 'lint', 'test'];
    const before = taskHashes(root, tasks);
    writeJson(path.join(root, 'tsconfig.base.json'), {
      compilerOptions: { strict: true, noUncheckedIndexedAccess: true },
    });
    const after = taskHashes(root, tasks);
    const packageTasks = Object.keys(after)
      .filter((id) => !id.startsWith('//#'))
      .sort();
    assert.equal(packageTasks.length, 16);
    assert.deepEqual(
      changedTasks(before, after).filter((id) => !id.startsWith('//#')),
      packageTasks,
    );
  });

  it('adding or changing the ESLint flat config busts every task (stale cache)', () => {
    const tasks = ['lint', 'typecheck'];
    const before = taskHashes(root, tasks);
    writeFileSync(path.join(root, 'eslint.config.mjs'), 'export default [];\n');
    const added = taskHashes(root, tasks);
    assert.deepEqual(changedTasks(before, added), Object.keys(added).sort());
    writeFileSync(path.join(root, 'eslint.config.mjs'), 'export default [{ rules: {} }];\n');
    const changed = taskHashes(root, tasks);
    assert.deepEqual(changedTasks(added, changed), Object.keys(changed).sort());
  });

  it("a dependency's source change invalidates its dependents but not unrelated packages", () => {
    const before = taskHashes(root, ['typecheck']);
    writeFileSync(
      path.join(root, 'packages', 'a', 'src', 'index.ts'),
      'export const name = "a";\nexport const changed = true;\n',
    );
    const after = taskHashes(root, ['typecheck']);
    assert.deepEqual(changedTasks(before, after), [
      'a#build',
      'a#typecheck',
      'b#build',
      'b#typecheck',
      'c#typecheck',
    ]);
  });

  it("tracked files outside src/ bust the package's tasks; gitignored dist/ and .turbo/ do not", () => {
    const tasks = ['typecheck', 'test', 'lint'];
    const before = taskHashes(root, tasks);
    mkdirSync(path.join(root, 'packages', 'd', 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'packages', 'd', 'dist', 'stray.js'), 'export {};\n');
    mkdirSync(path.join(root, 'packages', 'd', '.turbo'), { recursive: true });
    writeFileSync(path.join(root, 'packages', 'd', '.turbo', 'stray.log'), 'log\n');
    assert.deepEqual(
      changedTasks(before, taskHashes(root, tasks)),
      [],
      'build outputs and logs are not inputs',
    );
    rmSync(path.join(root, 'packages', 'd', 'dist'), { recursive: true, force: true });
    // e.g. packages/testing/typefixtures: a nested project tsc -b builds from outside src/.
    mkdirSync(path.join(root, 'packages', 'd', 'typefixtures'));
    writeFileSync(path.join(root, 'packages', 'd', 'typefixtures', 'strict.ts'), 'export {};\n');
    assert.deepEqual(changedTasks(before, taskHashes(root, tasks)), [
      'd#lint',
      'd#test',
      'd#typecheck',
    ]);
  });

  it('editing a test file re-runs build too (tsc emits tests into dist/) and every dependent', () => {
    const before = taskHashes(root, ['typecheck', 'test']);
    writeFileSync(path.join(root, 'packages', 'a', 'src', 'index.test.ts'), '// changed test\n');
    const after = taskHashes(root, ['typecheck', 'test']);
    assert.deepEqual(changedTasks(before, after), [
      'a#build',
      'a#test',
      'a#typecheck',
      'b#build',
      'b#test',
      'b#typecheck',
      'c#test',
      'c#typecheck',
    ]);
  });

  it('test depends on upstream builds and the root script self-tests', () => {
    const graph = dryRun(root, ['test']);
    const b = defined(
      graph.tasks.find((t) => t.taskId === 'b#test'),
      'b#test',
    );
    assert.deepEqual([...b.dependencies].sort(), ['//#test:scripts', 'a#build']);
    assert.deepEqual(b.resolvedTaskDefinition.outputs, ['coverage/**']);
    const scripts = defined(
      graph.tasks.find((t) => t.taskId === '//#test:scripts'),
      '//#test:scripts',
    );
    assert.equal(scripts.resolvedTaskDefinition.cache, false);
  });

  it('test:int and test:e2e are never cached (they touch external services)', () => {
    const io = dryRun(root, ['test:int', 'test:e2e']).tasks.filter(
      (x) => x.task === 'test:int' || x.task === 'test:e2e',
    );
    assert.equal(io.length, 8);
    for (const t of io) {
      assert.equal(t.resolvedTaskDefinition.cache, false, t.taskId);
      assert.deepEqual(t.resolvedTaskDefinition.outputs, [], t.taskId);
    }
    resetTaskLog(root);
    for (let i = 0; i < 2; i += 1) {
      const { statuses, output } = runSummarized(root, ['test:int', 'test:e2e', '--filter=d']);
      assert.doesNotMatch(output, /FULL TURBO/);
      assert.equal(statuses['d#test:int'], 'MISS');
      assert.equal(statuses['d#test:e2e'], 'MISS');
    }
    const log = readTaskLog(root);
    assert.equal(log.filter((l) => l === 'd test:int').length, 2, 'test:int ran twice');
    assert.equal(log.filter((l) => l === 'd test:e2e').length, 2, 'test:e2e ran twice');
  });

  it('dev is persistent, uncached and independent of builds', () => {
    const dev = dryRun(root, ['dev', '--parallel']).tasks.filter((t) => t.task === 'dev');
    assert.equal(dev.length, 4);
    for (const t of dev) {
      assert.equal(t.resolvedTaskDefinition.persistent, true, t.taskId);
      assert.equal(t.resolvedTaskDefinition.cache, false, t.taskId);
      assert.deepEqual(t.dependencies, [], t.taskId);
    }
  });

  it('a build that declares dist/** but writes nothing is reported (missing build output)', () => {
    const override = path.join(root, 'packages', 'd', 'turbo.json');
    const saved = readFileSync(override, 'utf8');
    rmSync(override);
    try {
      const { summary, output } = runSummarized(root, ['build', '--filter=d']);
      assert.match(output, /no output files found for task d#build/);
      const errors = checkRunSummary(summary);
      assert.equal(errors.length, 1, errors.join('\n'));
      assertError(
        errors,
        /^d#build: declares outputs \[dist\/\*\*\] but produced no matching files/,
      );
      const cli = spawnSync(
        process.execPath,
        [path.join(SCRIPTS_DIR, 'check-turbo.mjs'), '--root', root, '--latest-summary', '--quiet'],
        { encoding: 'utf8', env: turboEnv() },
      );
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /d#build: declares outputs/);
    } finally {
      writeFileSync(override, saved);
    }
    const { summary, output } = runSummarized(root, ['build', '--filter=d']);
    assert.doesNotMatch(output, /no output files found/);
    assert.deepEqual(checkRunSummary(summary), []);
  });

  it('never uses a remote cache, even with remote-cache credentials in the environment', () => {
    // An unroutable API URL: any remote-cache request would fail or stall the run.
    const env = {
      TURBO_API: 'http://127.0.0.1:9',
      TURBO_TOKEN: 'fixture-not-a-token',
      TURBO_TEAM: 'team_fixture',
    };
    const { summary, output } = runSummarized(root, ['build', '--filter=d'], env);
    assert.match(output, /Remote caching disabled/);
    for (const task of summary.tasks) assert.equal(task.cache.remote, false, task.taskId);
  });
});
