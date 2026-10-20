import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  BASE_CONFIG,
  REQUIRED_BASE_OPTIONS,
  STRICT_FAMILY,
  TYPECHECK_SCRIPT,
  checkTsconfig,
  findCycles,
} from './check-tsconfig.mjs';
import {
  REPO_ROOT,
  SCRIPTS_DIR,
  asArray,
  asObject,
  cleanEnv,
  parseJsonObject,
  readJsonObject,
  writeJson,
} from './test-fixtures.mjs';

const CHECK_TSCONFIG = path.join(SCRIPTS_DIR, 'check-tsconfig.mjs');

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
 * Reads a JSON document (package.json / tsconfig.json), lets the test edit it in place and
 * writes it back.
 * @param {string} file
 * @param {(value: import("./test-fixtures.mjs").JsonObject) => void} mutate
 */
function editJson(file, mutate) {
  const value = readJsonObject(file);
  mutate(value);
  writeJson(file, value);
}

/**
 * Writes one workspace member with a conforming package.json and tsconfig.json.
 * @param {string} root
 * @param {string} dir
 * @param {{ deps?: string[], compilerOptions?: Record<string, unknown> }} [opts]
 */
function writeTsMember(root, dir, opts = {}) {
  const deps = opts.deps ?? [];
  writeJson(path.join(root, dir, 'package.json'), {
    name: `@blackwing/${path.basename(dir)}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: { typecheck: TYPECHECK_SCRIPT },
    dependencies: Object.fromEntries(
      deps.map((dep) => [`@blackwing/${path.basename(dep)}`, 'workspace:*']),
    ),
    devDependencies: { typescript: 'catalog:' },
  });
  writeJson(path.join(root, dir, 'tsconfig.json'), {
    extends: `../../${BASE_CONFIG}`,
    compilerOptions: {
      rootDir: 'src',
      outDir: 'dist',
      tsBuildInfoFile: 'dist/.tsbuildinfo',
      ...opts.compilerOptions,
    },
    include: ['src'],
    references: deps.map((dep) => ({ path: `../../${dep}` })),
  });
  mkdirSync(path.join(root, dir, 'src'), { recursive: true });
  writeFileSync(
    path.join(root, dir, 'src', 'index.ts'),
    `export const name = "@blackwing/${path.basename(dir)}";\n`,
  );
}

const MEMBERS = [
  'packages/contracts',
  'packages/logger',
  'packages/testing',
  'apps/api',
  'apps/web',
];

/**
 * A minimal repository whose TypeScript setup passes every check: the real base config, a small
 * dependency chain (api -> logger -> contracts), the apps/web exception and a nested project.
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-tsconfig-'));
  copyFileSync(path.join(REPO_ROOT, BASE_CONFIG), path.join(root, BASE_CONFIG));
  writeTsMember(root, 'packages/contracts');
  writeTsMember(root, 'packages/logger', { deps: ['packages/contracts'] });
  writeTsMember(root, 'packages/testing');
  writeTsMember(root, 'apps/api', { deps: ['packages/contracts', 'packages/logger'] });
  writeTsMember(root, 'apps/web', {
    deps: ['packages/contracts'],
    compilerOptions: {
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      jsx: 'preserve',
    },
  });
  // Nested compile-fail fixture project, referenced from packages/testing.
  editJson(path.join(root, 'packages/testing/tsconfig.json'), (value) => {
    value.references = [{ path: 'typefixtures' }];
  });
  writeJson(path.join(root, 'packages/testing/typefixtures/tsconfig.json'), {
    extends: '../../../tsconfig.base.json',
    compilerOptions: {
      rootDir: '.',
      outDir: '../dist/typefixtures',
      tsBuildInfoFile: '../dist/typefixtures/.tsbuildinfo',
    },
    include: ['**/*.ts'],
  });
  writeFileSync(
    path.join(root, 'packages/testing/typefixtures/fixture.ts'),
    'export const fixture = 1;\n',
  );
  writeJson(path.join(root, 'tsconfig.json'), {
    files: [],
    references: MEMBERS.map((dir) => ({ path: dir })),
  });
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('check-tsconfig against this repository', () => {
  it('passes: every member extends the strict base and the solution references all of them', () => {
    const result = checkTsconfig(REPO_ROOT);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(result.members.length, 33);
    // 33 members + packages/testing/typefixtures.
    assert.equal(result.projects, 34);
  });

  it('pins the mandated base options (FOUND-003 detailed requirements 1-2)', () => {
    const base = asObject(readJsonObject(path.join(REPO_ROOT, BASE_CONFIG)).compilerOptions);
    for (const [key, value] of Object.entries(REQUIRED_BASE_OPTIONS)) {
      assert.deepEqual(base[key], value, `compilerOptions.${key}`);
    }
    for (const key of [
      'strict',
      'noUncheckedIndexedAccess',
      'exactOptionalPropertyTypes',
      'noImplicitOverride',
      'noFallthroughCasesInSwitch',
      'forceConsistentCasingInFileNames',
      'verbatimModuleSyntax',
      'isolatedModules',
      'skipLibCheck',
      'declaration',
      'declarationMap',
      'sourceMap',
      'composite',
    ]) {
      assert.equal(base[key], true, `compilerOptions.${key}`);
    }
    assert.equal(base.module, 'NodeNext');
    assert.equal(base.moduleResolution, 'NodeNext');
    assert.equal(base.target, 'ES2023');
    assert.deepEqual(base.lib, ['ES2023']);
    assert.notEqual(base.allowJs, true);
  });

  it('gives every member the exact typecheck script', () => {
    for (const member of checkTsconfig(REPO_ROOT).members) {
      const manifest = readJsonObject(path.join(REPO_ROOT, member.dir, 'package.json'));
      assert.equal(asObject(manifest.scripts).typecheck, TYPECHECK_SCRIPT, member.dir);
    }
  });
});

describe('checkTsconfig (fixtures)', () => {
  /** @type {{ root: string, cleanup: () => void }} */
  let fixture;
  beforeEach(() => {
    fixture = makeFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  /** @param {string} rel */
  const file = (rel) => path.join(fixture.root, rel);

  it('passes for a conforming setup with the apps/web exception and a nested project', () => {
    const result = checkTsconfig(fixture.root);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.members.find((m) => m.dir === 'apps/api')?.references, [
      'packages/contracts',
      'packages/logger',
    ]);
  });

  it('fails when the base config is missing', () => {
    rmSync(file(BASE_CONFIG));
    assertError(checkTsconfig(fixture.root).errors, /tsconfig\.base\.json: missing/);
  });

  for (const key of Object.keys(REQUIRED_BASE_OPTIONS)) {
    it(`fails when the base drops or changes compilerOptions.${key}`, () => {
      editJson(file(BASE_CONFIG), (value) => {
        Reflect.deleteProperty(asObject(value.compilerOptions), key);
      });
      assertError(
        checkTsconfig(fixture.root).errors,
        new RegExp(`tsconfig\\.base\\.json: compilerOptions\\.${key} must be`),
      );
    });
  }

  it('fails when the base widens lib with DOM (loose libs)', () => {
    editJson(file(BASE_CONFIG), (value) => {
      asObject(value.compilerOptions).lib = ['ES2023', 'DOM'];
    });
    const errors = checkTsconfig(fixture.root).errors;
    assertError(errors, /tsconfig\.base\.json: compilerOptions\.lib must be \["ES2023"\]/);
    assertError(
      errors,
      /packages\/contracts\/tsconfig\.json: compilerOptions\.lib must be \[lib\.es2023\.d\.ts\]/,
    );
  });

  it('fails when the base enables allowJs or checkJs', () => {
    editJson(file(BASE_CONFIG), (value) => {
      asObject(value.compilerOptions).allowJs = true;
      asObject(value.compilerOptions).checkJs = true;
    });
    const errors = checkTsconfig(fixture.root).errors;
    assertError(errors, /tsconfig\.base\.json: compilerOptions\.allowJs must be false/);
    assertError(errors, /tsconfig\.base\.json: compilerOptions\.checkJs must not be enabled/);
    assertError(
      errors,
      /packages\/contracts\/tsconfig\.json: compilerOptions\.allowJs must not be true/,
    );
  });

  for (const [option, relaxed] of /** @type {[string, unknown][]} */ ([
    ['strict', false],
    ['noUncheckedIndexedAccess', false],
    ['exactOptionalPropertyTypes', false],
    ['noImplicitOverride', false],
    ['noFallthroughCasesInSwitch', false],
    ['verbatimModuleSyntax', false],
    ['composite', false],
    ['allowJs', true],
    ['allowUnreachableCode', true],
  ])) {
    it(`fails when a member relaxes ${option} (app code is never relaxed)`, () => {
      editJson(file('apps/api/tsconfig.json'), (value) => {
        asObject(value.compilerOptions)[option] = relaxed;
      });
      assertError(
        checkTsconfig(fixture.root).errors,
        new RegExp(`apps/api/tsconfig\\.json: .*compilerOptions\\.${option} must`),
      );
    });
  }

  for (const option of STRICT_FAMILY) {
    it(`fails when a member switches strict-family flag ${option} off`, () => {
      editJson(file('packages/logger/tsconfig.json'), (value) => {
        asObject(value.compilerOptions)[option] = false;
      });
      assertError(
        checkTsconfig(fixture.root).errors,
        new RegExp(
          `packages/logger/tsconfig\\.json: compilerOptions\\.${option} must not be false`,
        ),
      );
    });
  }

  it('rejects bundler resolution outside the documented apps/web exception', () => {
    editJson(file('apps/api/tsconfig.json'), (value) => {
      asObject(value.compilerOptions).module = 'ESNext';
      asObject(value.compilerOptions).moduleResolution = 'Bundler';
    });
    const errors = checkTsconfig(fixture.root).errors;
    assertError(
      errors,
      /apps\/api\/tsconfig\.json: compilerOptions\.module must be NodeNext \(only the documented apps\/web exception/,
    );
    assertError(
      errors,
      /apps\/api\/tsconfig\.json: compilerOptions\.moduleResolution must be NodeNext/,
    );
  });

  it('holds apps/web to the exact documented exception', () => {
    editJson(file('apps/web/tsconfig.json'), (value) => {
      asObject(value.compilerOptions).lib = ['ES2023', 'DOM', 'DOM.Iterable', 'WebWorker'];
      asObject(value.compilerOptions).exactOptionalPropertyTypes = false;
    });
    const errors = checkTsconfig(fixture.root).errors;
    assertError(
      errors,
      /apps\/web\/tsconfig\.json: compilerOptions\.lib must be .*\(documented exception\)/,
    );
    assertError(
      errors,
      /apps\/web\/tsconfig\.json: effective compilerOptions\.exactOptionalPropertyTypes must be true/,
    );
  });

  it('fails when a member has no tsconfig.json', () => {
    rmSync(file('packages/logger/tsconfig.json'));
    assertError(checkTsconfig(fixture.root).errors, /packages\/logger\/tsconfig\.json: missing/);
  });

  it('fails when a member does not extend the base directly', () => {
    editJson(file('packages/logger/tsconfig.json'), (value) => {
      delete value.extends;
    });
    assertError(
      checkTsconfig(fixture.root).errors,
      /packages\/logger\/tsconfig\.json: "extends" must be "\.\.\/\.\.\/tsconfig\.base\.json"/,
    );
  });

  it('fails when outDir, rootDir or tsBuildInfoFile move', () => {
    editJson(file('packages/logger/tsconfig.json'), (value) => {
      asObject(value.compilerOptions).outDir = 'build';
      asObject(value.compilerOptions).rootDir = '.';
      delete asObject(value.compilerOptions).tsBuildInfoFile;
    });
    const errors = checkTsconfig(fixture.root).errors;
    assertError(errors, /packages\/logger\/tsconfig\.json: compilerOptions\.outDir must be "dist"/);
    assertError(errors, /packages\/logger\/tsconfig\.json: compilerOptions\.rootDir must be "src"/);
    assertError(
      errors,
      /packages\/logger\/tsconfig\.json: compilerOptions\.tsBuildInfoFile must be "dist\/\.tsbuildinfo"/,
    );
  });

  it('fails when a workspace dependency has no matching reference', () => {
    editJson(file('apps/api/tsconfig.json'), (value) => {
      value.references = [{ path: '../../packages/contracts' }];
    });
    assertError(
      checkTsconfig(fixture.root).errors,
      /apps\/api\/tsconfig\.json: depends on "@blackwing\/logger" but has no \{ "path": "\.\.\/\.\.\/packages\/logger" \} reference/,
    );
  });

  it('fails when a reference has no matching workspace dependency', () => {
    editJson(file('packages/contracts/tsconfig.json'), (value) => {
      value.references = [{ path: '../logger' }];
    });
    assertError(
      checkTsconfig(fixture.root).errors,
      /packages\/contracts\/tsconfig\.json: references packages\/logger but package\.json does not depend on "@blackwing\/logger"/,
    );
  });

  it('fails on a dependency on an unknown workspace package', () => {
    editJson(file('apps/api/package.json'), (value) => {
      asObject(value.dependencies)['@blackwing/nope'] = 'workspace:*';
    });
    assertError(
      checkTsconfig(fixture.root).errors,
      /apps\/api\/package\.json: depends on unknown workspace package "@blackwing\/nope"/,
    );
  });

  it('names circular project references (contracts -> logger -> contracts)', () => {
    editJson(file('packages/contracts/package.json'), (value) => {
      value.dependencies = { '@blackwing/logger': 'workspace:*' };
    });
    editJson(file('packages/contracts/tsconfig.json'), (value) => {
      value.references = [{ path: '../logger' }];
    });
    assertError(
      checkTsconfig(fixture.root).errors,
      /circular project references: packages\/contracts -> packages\/logger -> packages\/contracts/,
    );
  });

  it('fails when the solution file misses a member or compiles files itself', () => {
    editJson(file('tsconfig.json'), (value) => {
      value.references = asArray(value.references).filter((r) => asObject(r).path !== 'apps/web');
      value.include = ['scripts'];
      delete value.files;
    });
    const errors = checkTsconfig(fixture.root).errors;
    assertError(errors, /^tsconfig\.json: missing reference \{ "path": "apps\/web" \}/);
    assertError(errors, /^tsconfig\.json: must not declare "include"/);
    assertError(errors, /^tsconfig\.json: must declare "files": \[\]/);
  });

  it('fails when the solution file references something that is not a member', () => {
    editJson(file('tsconfig.json'), (value) => {
      asArray(value.references).push({ path: 'packages/testing/typefixtures' });
    });
    assertError(
      checkTsconfig(fixture.root).errors,
      /^tsconfig\.json: reference "packages\/testing\/typefixtures" is not a workspace member/,
    );
  });

  it('holds nested projects to the same strictness', () => {
    editJson(file('packages/testing/typefixtures/tsconfig.json'), (value) => {
      asObject(value.compilerOptions).noUncheckedIndexedAccess = false;
      asObject(value.compilerOptions).outDir = '../out';
    });
    const errors = checkTsconfig(fixture.root).errors;
    assertError(
      errors,
      /packages\/testing\/typefixtures\/tsconfig\.json: effective compilerOptions\.noUncheckedIndexedAccess must be true/,
    );
    assertError(
      errors,
      /packages\/testing\/typefixtures\/tsconfig\.json: compilerOptions\.outDir must be inside a dist\/ directory/,
    );
  });

  it('rejects a reference that is neither a dependency nor nested', () => {
    mkdirSync(file('tools/extra'), { recursive: true });
    writeJson(file('tools/extra/tsconfig.json'), {
      extends: '../../tsconfig.base.json',
      files: [],
    });
    editJson(file('apps/api/tsconfig.json'), (value) => {
      asArray(value.references).push({ path: '../../tools/extra' });
    });
    assertError(
      checkTsconfig(fixture.root).errors,
      /apps\/api\/tsconfig\.json: reference "tools\/extra" is neither a workspace dependency/,
    );
  });

  it("fails when a member's typecheck script differs or typescript is not a devDependency", () => {
    editJson(file('packages/logger/package.json'), (value) => {
      asObject(value.scripts).typecheck = 'tsc --noEmit';
      delete asObject(value.devDependencies).typescript;
    });
    const errors = checkTsconfig(fixture.root).errors;
    assertError(
      errors,
      /packages\/logger\/package\.json: "scripts\.typecheck" must be "tsc -b --pretty false"/,
    );
    assertError(
      errors,
      /packages\/logger\/package\.json: "devDependencies\.typescript" is required/,
    );
  });

  it('CLI exits 0 with a JSON summary, and 1 with the problems on stderr', () => {
    const ok = spawnSync(process.execPath, [CHECK_TSCONFIG, '--root', fixture.root], {
      encoding: 'utf8',
      env: cleanEnv(),
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(parseJsonObject(ok.stdout).ok, true);

    editJson(file('packages/logger/tsconfig.json'), (value) => {
      asObject(value.compilerOptions).strict = false;
    });
    const bad = spawnSync(process.execPath, [CHECK_TSCONFIG, '--root', fixture.root, '--quiet'], {
      encoding: 'utf8',
      env: cleanEnv(),
    });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
    assert.match(
      bad.stderr,
      /packages\/logger\/tsconfig\.json: effective compilerOptions\.strict must be true/,
    );
  });

  it('CLI rejects unknown arguments with exit code 2', () => {
    const run = spawnSync(process.execPath, [CHECK_TSCONFIG, '--bogus'], {
      encoding: 'utf8',
      env: cleanEnv(),
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown argument: --bogus/);
  });
});

describe('findCycles', () => {
  it('returns no cycles for a DAG', () => {
    const graph = new Map([
      ['a', ['b', 'c']],
      ['b', ['c']],
      ['c', []],
    ]);
    assert.deepEqual(findCycles(graph), []);
  });

  it('reports a self-reference and a longer cycle once each', () => {
    const graph = new Map([
      ['a', ['a']],
      ['b', ['c']],
      ['c', ['d']],
      ['d', ['b']],
    ]);
    assert.deepEqual(findCycles(graph), [
      ['a', 'a'],
      ['b', 'c', 'd', 'b'],
    ]);
  });
});
