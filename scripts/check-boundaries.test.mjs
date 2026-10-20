// Tests for the architectural boundary check (FOUND-005, #7): the model itself, the real
// repository, and fixture workspaces that recreate the full member layout (with pnpm-style
// workspace symlinks) and introduce one forbidden edge at a time.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import {
  DOC_FILE,
  ELEMENT_TYPES,
  SANDBOX_MEMBERS,
  SERVER_ONLY_MEMBERS,
  TESTING_MEMBER,
  VIOLATION_KINDS,
  checkBoundaries,
  classifyMember,
  findCycles,
  formatAnnotations,
  formatReport,
  isAllowedEdge,
  isTestCode,
  main,
  parseArgs,
  renderDependencyGraphDoc,
} from './check-boundaries.mjs';
import { EXPECTED_APPS, EXPECTED_PACKAGES } from './check-layout.mjs';
import {
  REPO_ROOT,
  asArray,
  asObject,
  defined,
  parseJsonObject,
  writeJson,
} from './test-fixtures.mjs';

/** @typedef {import('./check-boundaries.mjs').BoundaryReport} BoundaryReport */
/** @typedef {import('./check-boundaries.mjs').Violation} Violation */

/** Every member directory the model knows about. */
const MODEL_MEMBERS = ELEMENT_TYPES.flatMap((t) => [...t.members]);

/**
 * @param {string} dir
 * @returns {string}
 */
const nameOf = (dir) => `@blackwing/${path.basename(dir)}`;

/**
 * A fixture workspace with every member of the model, each with a package.json (exports
 * "./src/index.ts") and a src/index.ts. Workspace dependencies are linked the way pnpm links
 * them: <member>/node_modules/@blackwing/<dep> is a relative symlink to the dependency's
 * directory.
 */
class Workspace {
  constructor() {
    this.root = mkdtempSync(path.join(tmpdir(), 'bw-boundaries-'));
    writeFileSync(
      path.join(this.root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    );
    for (const dir of MODEL_MEMBERS) this.member(dir);
  }

  /**
   * Writes (or rewrites) a member's package.json and entry point.
   * @param {string} dir
   * @param {Record<string, unknown>} [extra]  extra package.json fields
   */
  member(dir, extra = {}) {
    writeJson(path.join(this.root, dir, 'package.json'), {
      name: nameOf(dir),
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      ...extra,
    });
    this.write(`${dir}/src/index.ts`, `export const name = '${nameOf(dir)}';\n`);
  }

  /**
   * Declares a workspace dependency in package.json and links it like pnpm does.
   * @param {string} from  member directory
   * @param {string} to    member directory
   * @param {'dependencies' | 'devDependencies'} [field]
   */
  depend(from, to, field = 'dependencies') {
    const manifestFile = path.join(this.root, from, 'package.json');
    const manifest = parseJsonObject(readFileSync(manifestFile, 'utf8'));
    const deps = manifest[field] === undefined ? {} : asObject(manifest[field]);
    deps[nameOf(to)] = 'workspace:*';
    manifest[field] = deps;
    writeJson(manifestFile, manifest);
    this.link(from, to);
  }

  /**
   * Links a dependency into node_modules without declaring it.
   * @param {string} from
   * @param {string} to
   */
  link(from, to) {
    const linkDir = path.join(this.root, from, 'node_modules', '@blackwing');
    mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, path.basename(to));
    rmSync(link, { force: true });
    symlinkSync(path.relative(linkDir, path.join(this.root, to)), link, 'dir');
  }

  /**
   * @param {string} rel
   * @param {string} content
   */
  write(rel, content) {
    mkdirSync(path.dirname(path.join(this.root, rel)), { recursive: true });
    writeFileSync(path.join(this.root, rel), content);
  }

  /**
   * @param {{ docs?: boolean }} [options]
   * @returns {Promise<BoundaryReport>}
   */
  check(options = { docs: false }) {
    return checkBoundaries(this.root, options);
  }

  cleanup() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * @param {BoundaryReport} report
 * @param {string} rule
 * @returns {Violation[]}
 */
const byRule = (report, rule) => report.violations.filter((v) => v.rule === rule);

/**
 * Captures stdout/stderr writes during an async call.
 * @param {() => Promise<number>} fn
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function capture(fn) {
  let stdout = '';
  let stderr = '';
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    (/** @type {string | Uint8Array} */ chunk) => {
      stdout += String(chunk);
      return true;
    }
  );
  process.stderr.write = /** @type {typeof process.stderr.write} */ (
    (/** @type {string | Uint8Array} */ chunk) => {
      stderr += String(chunk);
      return true;
    }
  );
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/**
 * First member of a type usable as an edge endpoint in the fixtures: not the test-helper
 * package (it has its own rule) and not sandbox code (it has an extra transitive rule).
 * @param {string} type
 * @param {string} [not]  a member to avoid
 * @returns {string | undefined}
 */
function pick(type, not) {
  const t = ELEMENT_TYPES.find((x) => x.name === type);
  return t?.members.find(
    (m) =>
      m !== not && m !== TESTING_MEMBER && !SANDBOX_MEMBERS.includes(m) && m !== 'packages/time',
  );
}

describe('the boundary model', () => {
  it('classifies every app and package of the CONTEXT_PACK §6 layout exactly once', () => {
    for (const dir of [
      ...EXPECTED_APPS.map((a) => `apps/${a}`),
      ...EXPECTED_PACKAGES.map((p) => `packages/${p}`),
    ]) {
      const types = ELEMENT_TYPES.filter((t) => t.members.includes(dir));
      assert.equal(types.length, 1, `${dir} must have exactly one element type`);
    }
    assert.equal(new Set(MODEL_MEMBERS).size, MODEL_MEMBERS.length, 'no member is listed twice');
  });

  it('declares the element types and edges FOUND-005 requires', () => {
    assert.deepEqual(
      ELEMENT_TYPES.map((t) => t.name),
      ['contracts', 'shared-lib', 'domain', 'policy', 'service-lib', 'app', 'go-service'],
    );
    for (const lib of ['config', 'logger', 'ids', 'time', 'errors', 'testing']) {
      assert.equal(classifyMember(`packages/${lib}`), 'shared-lib', lib);
    }
    assert.equal(classifyMember('packages/contracts'), 'contracts');
    assert.equal(classifyMember('packages/domain'), 'domain');
    assert.equal(classifyMember('packages/policy'), 'policy');
    assert.equal(classifyMember('apps/egress-gateway'), 'go-service');
    assert.equal(classifyMember('apps/api'), 'app');
    assert.equal(classifyMember('packages/nope'), null);

    const names = ELEMENT_TYPES.map((t) => t.name);
    for (const to of names)
      assert.equal(isAllowedEdge('contracts', to), false, `contracts -> ${to}`);
    assert.deepEqual(
      names.filter((to) => isAllowedEdge('shared-lib', to)),
      ['contracts', 'shared-lib'],
    );
    assert.deepEqual(
      names.filter((to) => isAllowedEdge('domain', to)),
      ['contracts', 'shared-lib'],
    );
    assert.deepEqual(
      names.filter((to) => isAllowedEdge('policy', to)),
      ['contracts', 'shared-lib'],
    );
    assert.deepEqual(
      names.filter((to) => isAllowedEdge('app', to)),
      ['contracts', 'shared-lib', 'domain', 'policy', 'service-lib'],
    );
    for (const to of names) assert.equal(isAllowedEdge('go-service', to), false);
    for (const from of names) assert.equal(isAllowedEdge(from, 'app'), false, `${from} -> app`);
    for (const from of names) assert.equal(isAllowedEdge(from, 'go-service'), false);
  });

  it('is a DAG apart from the documented intra-type edges', () => {
    /** @type {Map<string, Set<string>>} */
    const graph = new Map(
      ELEMENT_TYPES.map((t) => [t.name, new Set(t.mayImport.filter((to) => to !== t.name))]),
    );
    assert.deepEqual(findCycles(graph), []);
    assert.deepEqual(
      ELEMENT_TYPES.filter((t) => t.mayImport.includes(t.name)).map((t) => t.name),
      ['shared-lib', 'service-lib'],
    );
    for (const t of ELEMENT_TYPES) {
      for (const to of t.mayImport) {
        assert.ok(
          ELEMENT_TYPES.some((x) => x.name === to),
          `${t.name} -> unknown ${to}`,
        );
      }
    }
  });

  it('keeps sandbox code and server-only packages where the architecture puts them', () => {
    assert.deepEqual([...SANDBOX_MEMBERS], ['apps/agent-runtime', 'packages/mcp-tools']);
    for (const dir of SERVER_ONLY_MEMBERS) assert.equal(classifyMember(dir), 'service-lib', dir);
    assert.equal(classifyMember(TESTING_MEMBER), 'shared-lib');
  });

  it('recognises test code', () => {
    for (const file of [
      'packages/a/src/x.test.ts',
      'packages/a/src/x.spec.tsx',
      'packages/a/test/helpers.ts',
      'packages/a/src/__tests__/x.ts',
      'packages/a/src/testdata/app-config.ts',
      'packages/testing/typefixtures/strict.ts',
      'apps/web/e2e/login.ts',
      'packages/a/vitest.config.ts',
    ]) {
      assert.equal(isTestCode(file), true, file);
    }
    for (const file of [
      'packages/a/src/x.ts',
      'packages/a/src/testing.ts',
      'apps/web/src/latest.ts',
    ]) {
      assert.equal(isTestCode(file), false, file);
    }
  });

  it('finds package cycles with a concrete path', () => {
    /** @type {Map<string, Set<string>>} */
    const graph = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
      ['d', new Set(['a'])],
      ['e', new Set()],
    ]);
    assert.deepEqual(findCycles(graph), [['a', 'b', 'c', 'a']]);
    assert.deepEqual(
      findCycles(
        new Map([
          ['x', new Set(['y'])],
          ['y', new Set()],
        ]),
      ),
      [],
    );
  });
});

describe('the real repository', () => {
  it('passes pnpm boundaries:check on the current tree, including the generated docs', async () => {
    const report = await checkBoundaries(REPO_ROOT);
    assert.deepEqual(report.violations, [], formatReport(report));
    assert.deepEqual(report.cycles, []);
    assert.equal(report.ok, true);
    assert.ok(report.summary.modules > 0);
    assert.equal(report.summary.members, EXPECTED_APPS.length + EXPECTED_PACKAGES.length);
  });

  it('wires the root scripts, ignores the report file and links the generated doc', () => {
    const manifest = parseJsonObject(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const scripts = asObject(manifest.scripts);
    assert.equal(scripts['boundaries:check'], 'node scripts/check-boundaries.mjs');
    assert.equal(
      scripts['boundaries:report'],
      'node scripts/check-boundaries.mjs --json boundaries-report.json',
    );
    assert.equal(scripts['boundaries:docs'], 'node scripts/check-boundaries.mjs --write-docs');
    const devDeps = asObject(manifest.devDependencies);
    assert.match(String(devDeps['dependency-cruiser']), /^\d+\.\d+\.\d+$/, 'pinned exactly');
    assert.match(
      readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8'),
      /^boundaries-report\.json$/m,
    );
    assert.equal(readFileSync(path.join(REPO_ROOT, DOC_FILE), 'utf8'), renderDependencyGraphDoc());
  });
});

describe('fixture workspaces', () => {
  /** @type {Workspace} */
  let ws;
  beforeEach(() => {
    ws = new Workspace();
  });
  afterEach(() => {
    ws.cleanup();
  });

  it('a clean workspace with every allowed edge passes', async () => {
    let n = 0;
    for (const from of ELEMENT_TYPES) {
      const source = pick(from.name);
      if (source === undefined) continue;
      for (const toType of from.mayImport) {
        const target = pick(toType, source);
        if (target === undefined) continue;
        // Within a type, only import "forward" in the member list so the fixture stays acyclic.
        if (toType === from.name && MODEL_MEMBERS.indexOf(target) < MODEL_MEMBERS.indexOf(source)) {
          continue;
        }
        ws.depend(source, target);
        ws.write(
          `${source}/src/uses-${path.basename(target)}.ts`,
          `export { name } from '${nameOf(target)}';\n`,
        );
        n += 1;
      }
    }
    // Test code anywhere may use @blackwing/testing.
    for (const dir of ['packages/contracts', 'apps/egress-gateway', 'packages/domain']) {
      ws.depend(dir, TESTING_MEMBER, 'devDependencies');
      ws.write(
        `${dir}/src/index.test.ts`,
        `import { name } from '@blackwing/testing';\nexport const t = name;\n`,
      );
    }
    assert.ok(n >= 15, `exercised ${n} allowed edges`);
    const report = await ws.check();
    assert.deepEqual(report.violations, [], formatReport(report));
    assert.deepEqual(report.cycles, []);
    assert.equal(report.ok, true);
  });

  it('rejects a deliberate contracts -> apps/api import and names the edge', async () => {
    ws.depend('packages/contracts', 'apps/api');
    ws.write(
      'packages/contracts/src/run.ts',
      "import { name } from '@blackwing/api';\nexport const n = name;\n",
    );
    const report = await ws.check();
    assert.equal(report.ok, false);
    const [edge, ...rest] = byRule(report, 'contracts-not-to-app').filter(
      (v) => v.from === 'packages/contracts/src/run.ts',
    );
    assert.equal(rest.length, 0);
    assert.ok(edge, formatReport(report));
    // Resolved through the pnpm symlink to the real member path, not node_modules.
    assert.equal(edge.to, 'apps/api/src/index.ts');
    assert.equal(edge.specifier, '@blackwing/api');
    assert.equal(edge.kind, 'boundary');
    assert.equal(edge.fromType, 'contracts');
    assert.equal(edge.toType, 'app');
    assert.equal(edge.toMember, 'apps/api');
    assert.match(edge.message, /packages\/contracts\/src\/run\.ts -> apps\/api\/src\/index\.ts/);
    // The declared dependency itself is a boundary violation too.
    const manifest = byRule(report, 'contracts-not-to-app').find(
      (v) => v.from === 'packages/contracts/package.json',
    );
    assert.ok(manifest);
    assert.equal(manifest.to, '@blackwing/api');

    const { code, stderr } = await capture(() => main(['--root', ws.root]));
    assert.equal(code, 1);
    assert.match(stderr, /contracts-not-to-app/);
    assert.match(stderr, /packages\/contracts\/src\/run\.ts -> apps\/api\/src\/index\.ts/);
  });

  it('rejects every forbidden edge between element types', async () => {
    /** @type {Array<{ rule: string, from: string, to: string }>} */
    const expected = [];
    for (const from of ELEMENT_TYPES) {
      const source = pick(from.name);
      if (source === undefined) continue;
      for (const to of ELEMENT_TYPES) {
        if (from.mayImport.includes(to.name)) continue;
        const target = pick(to.name, source);
        if (target === undefined) continue;
        const file = `${source}/src/edge-to-${path.basename(target)}.ts`;
        ws.depend(source, target);
        ws.write(file, `export { name } from '${nameOf(target)}';\n`);
        expected.push({
          rule: `${from.name}-not-to-${to.name}`,
          from: file,
          to: `${target}/src/index.ts`,
        });
      }
    }
    assert.ok(expected.length >= 20, `exercised ${expected.length} forbidden edges`);
    const report = await ws.check();
    const actual = report.violations
      .filter((v) => v.kind === 'boundary' && !v.from.endsWith('package.json'))
      .map((v) => ({ rule: v.rule, from: v.from, to: v.to }));
    const key = (/** @type {{ rule: string, from: string, to: string }} */ e) =>
      `${e.rule} ${e.from} ${e.to}`;
    assert.deepEqual(actual.map((e) => key(e)).sort(), expected.map((e) => key(e)).sort());
    // Every declared forbidden dependency is reported from package.json as well.
    assert.equal(
      report.violations.filter((v) => v.kind === 'boundary' && v.from.endsWith('package.json'))
        .length,
      expected.length,
    );
  });

  it('rejects app -> app, including the Go service, but allows an app its own modules', async () => {
    ws.depend('apps/web', 'apps/api');
    ws.depend('apps/worker', 'apps/egress-gateway');
    ws.write('apps/web/src/a.ts', "export { name } from '@blackwing/api';\n");
    ws.write('apps/web/src/b.ts', "export { name } from './index.js';\n");
    ws.write('apps/worker/src/a.ts', "export { name } from '@blackwing/egress-gateway';\n");
    const report = await ws.check();
    assert.deepEqual(
      report.violations
        .filter((v) => !v.from.endsWith('package.json'))
        .map((v) => `${v.rule} ${v.from}`),
      ['app-not-to-app apps/web/src/a.ts', 'app-not-to-go-service apps/worker/src/a.ts'],
    );
  });

  it('rejects the deep import @blackwing/config/src/x', async () => {
    ws.depend('apps/api', 'packages/config');
    ws.write('packages/config/src/x.ts', 'export const x = 1;\n');
    ws.write('apps/api/src/deep.ts', "export { x } from '@blackwing/config/src/x';\n");
    ws.write('apps/api/src/deep-js.ts', "export { x } from '@blackwing/config/src/x.js';\n");
    ws.write('apps/api/src/entry.ts', "export { name } from '@blackwing/config';\n");
    const report = await ws.check();
    const deep = report.violations.filter((v) => v.kind === 'deep-import');
    assert.deepEqual(
      deep.map((v) => `${v.rule} ${v.from} ${v.to}`),
      [
        'no-deep-import-specifier apps/api/src/deep-js.ts @blackwing/config/src/x.js',
        'no-deep-import-specifier apps/api/src/deep.ts @blackwing/config/src/x',
      ],
    );
    assert.equal(defined(deep[0]).toMember, 'packages/config');
    assert.match(defined(deep[0]).message, /deep import into @blackwing\/config/);
    // The deep specifier is not reported a second time as merely unresolvable.
    assert.deepEqual(byRule(report, 'no-unresolvable'), []);
    assert.equal(report.violations.length, deep.length, formatReport(report));
  });

  it('rejects relative imports into another member and src/ subpath exports', async () => {
    ws.write('packages/config/src/x.ts', 'export const x = 1;\n');
    ws.write('apps/api/src/rel.ts', "export { x } from '../../../packages/config/src/x.js';\n");
    ws.member('packages/logger', { exports: { '.': './src/index.ts', './src/*': './src/*' } });
    ws.write('packages/logger/src/inner.ts', 'export const inner = 1;\n');
    ws.depend('apps/api', 'packages/logger');
    ws.write('apps/api/src/sub.ts', "export { inner } from '@blackwing/logger/src/inner.ts';\n");
    const report = await ws.check();
    const rules = report.violations.map((v) => `${v.rule} ${v.from} ${v.to}`);
    assert.ok(
      rules.includes('no-deep-import apps/api/src/rel.ts packages/config/src/x.ts'),
      formatReport(report),
    );
    assert.ok(
      rules.includes('no-deep-import-specifier apps/api/src/sub.ts packages/logger/src/inner.ts'),
      formatReport(report),
    );
    assert.ok(
      rules.includes(
        'manifest-no-src-subpath-export packages/logger/package.json @blackwing/logger/src/*',
      ),
      formatReport(report),
    );
  });

  it('enforces type-only imports and re-exports, which the build erases', async () => {
    ws.depend('packages/contracts', 'apps/api');
    ws.write(
      'packages/contracts/src/types.ts',
      "import type { name } from '@blackwing/api';\nexport type N = typeof name;\n",
    );
    ws.write('packages/contracts/src/reexport.ts', "export type * from '@blackwing/api';\n");
    ws.write(
      'packages/contracts/src/inline.ts',
      "import { type name } from '@blackwing/api';\nexport type M = typeof name;\n",
    );
    const report = await ws.check();
    assert.deepEqual(
      byRule(report, 'contracts-not-to-app')
        .map((v) => v.from)
        .filter((f) => !f.endsWith('package.json')),
      [
        'packages/contracts/src/inline.ts',
        'packages/contracts/src/reexport.ts',
        'packages/contracts/src/types.ts',
      ],
    );
  });

  it('enforces dynamic import() and require()', async () => {
    ws.depend('packages/domain', 'packages/db');
    ws.write(
      'packages/domain/src/lazy.ts',
      "export async function load(): Promise<unknown> {\n  return import('@blackwing/db');\n}\n",
    );
    ws.write(
      'packages/domain/src/cjs.cts',
      "import db = require('@blackwing/db');\nexport const n = db;\n",
    );
    const report = await ws.check();
    assert.deepEqual(
      byRule(report, 'domain-not-to-service-lib')
        .map((v) => v.from)
        .filter((f) => !f.endsWith('package.json')),
      ['packages/domain/src/cjs.cts', 'packages/domain/src/lazy.ts'],
    );
  });

  it('names an undeclared workspace import by package and reports it unresolvable', async () => {
    ws.write('packages/contracts/src/run.ts', "export { name } from '@blackwing/api';\n");
    const report = await ws.check();
    const boundary = byRule(report, 'contracts-not-to-app');
    assert.equal(boundary.length, 1, formatReport(report));
    assert.equal(defined(boundary[0]).to, '@blackwing/api');
    assert.equal(defined(boundary[0]).toType, 'app');
    const unresolved = byRule(report, 'no-unresolvable');
    assert.equal(unresolved.length, 1);
    assert.equal(defined(unresolved[0]).kind, 'unresolvable');
  });

  it('lets test code import @blackwing/testing and keeps it out of production code', async () => {
    ws.depend('packages/contracts', TESTING_MEMBER, 'devDependencies');
    ws.write('packages/contracts/src/a.test.ts', "export { name } from '@blackwing/testing';\n");
    ws.write('packages/contracts/test/helpers.ts', "export { name } from '@blackwing/testing';\n");
    ws.write('packages/contracts/src/prod.ts', "export { name } from '@blackwing/testing';\n");
    ws.depend('packages/domain', TESTING_MEMBER);
    ws.write('packages/domain/src/prod.ts', "export { name } from '@blackwing/testing';\n");
    // Test code gets no other exemption.
    ws.depend('packages/contracts', 'apps/api', 'devDependencies');
    ws.write('packages/contracts/src/b.test.ts', "export { name } from '@blackwing/api';\n");
    const report = await ws.check();
    assert.deepEqual(
      byRule(report, 'testing-only-from-tests').map((v) => v.from),
      ['packages/contracts/src/prod.ts', 'packages/domain/src/prod.ts'],
    );
    assert.deepEqual(
      byRule(report, 'manifest-testing-only-dev').map((v) => v.from),
      ['packages/domain/package.json'],
    );
    assert.deepEqual(
      byRule(report, 'contracts-not-to-app').map((v) => v.from),
      ['packages/contracts/package.json', 'packages/contracts/src/b.test.ts'],
    );
    assert.deepEqual(byRule(report, 'contracts-not-to-shared-lib'), []);
  });

  it('keeps sandbox code away from server-only packages, directly and transitively', async () => {
    ws.depend('apps/agent-runtime', 'packages/db');
    ws.write('apps/agent-runtime/src/direct.ts', "export { name } from '@blackwing/db';\n");
    ws.depend('apps/agent-runtime', 'packages/agents');
    ws.depend('packages/agents', 'packages/secrets');
    ws.write('apps/agent-runtime/src/via.ts', "export { name } from '@blackwing/agents';\n");
    ws.write('packages/agents/src/index.ts', "export { name } from '@blackwing/secrets';\n");
    ws.depend('packages/mcp-tools', 'packages/audit');
    ws.write('packages/mcp-tools/src/tool.ts', "export { name } from '@blackwing/audit';\n");
    // Tests run outside the sandbox; other apps may use server-only packages.
    ws.write('apps/agent-runtime/src/direct.test.ts', "export { name } from '@blackwing/db';\n");
    ws.depend('apps/api', 'packages/db');
    ws.write('apps/api/src/db.ts', "export { name } from '@blackwing/db';\n");
    const report = await ws.check();
    const found = byRule(report, 'sandbox-not-to-server-only');
    assert.deepEqual(
      found.map((v) => `${v.from} -> ${v.to}`),
      [
        'apps/agent-runtime/src/direct.ts -> packages/db/src/index.ts',
        'apps/agent-runtime/src/via.ts -> packages/secrets/src/index.ts',
        'packages/mcp-tools/src/tool.ts -> packages/audit/src/index.ts',
      ],
      formatReport(report),
    );
    const via = found.find((v) => v.from === 'apps/agent-runtime/src/via.ts');
    assert.ok(via?.via.includes('packages/agents/src/index.ts'), JSON.stringify(via));
    assert.match(via?.message ?? '', /packages\/agents\/src\/index\.ts/);
    assert.ok(found.every((v) => v.kind === 'server-only'));
    assert.equal(report.violations.length, found.length, formatReport(report));
  });

  it('reports circular package dependencies separately from boundary violations', async () => {
    ws.write(DOC_FILE, renderDependencyGraphDoc());
    ws.depend('packages/config', 'packages/logger');
    ws.depend('packages/logger', 'packages/config');
    ws.write('packages/config/src/log.ts', "export { name } from '@blackwing/logger';\n");
    ws.write('packages/logger/src/cfg.ts', "export { name } from '@blackwing/config';\n");
    const report = await ws.check();
    assert.deepEqual(report.violations, [], 'shared-lib -> shared-lib is an allowed edge');
    assert.equal(report.ok, false);
    assert.deepEqual(report.cycles, [
      {
        kind: 'package-cycle',
        rule: 'no-package-cycle',
        path: ['packages/config', 'packages/logger', 'packages/config'],
        message: 'package cycle: packages/config -> packages/logger -> packages/config',
      },
    ]);
    const { code, stderr } = await capture(() =>
      main(['--root', ws.root, '--json', path.join(ws.root, 'r.json')]),
    );
    assert.equal(code, 1);
    assert.match(stderr, /1 circular dependency:/);
    assert.match(stderr, /\[package-cycle\] package cycle: packages\/config -> packages\/logger/);
    assert.doesNotMatch(stderr, /violation/);
  });

  it('detects package cycles declared only in package.json', async () => {
    ws.depend('packages/db', 'packages/audit');
    ws.depend('packages/audit', 'packages/db', 'devDependencies');
    const report = await ws.check();
    assert.deepEqual(
      report.cycles.map((c) => c.path),
      [['packages/audit', 'packages/db', 'packages/audit']],
    );
  });

  it('reports module cycles inside one package', async () => {
    ws.write(
      'packages/domain/src/a.ts',
      "import { b } from './b.js';\nexport const a = (): number => b() + 1;\n",
    );
    ws.write(
      'packages/domain/src/b.ts',
      "import { a } from './a.js';\nexport const b = (): number => a();\n",
    );
    const report = await ws.check();
    assert.deepEqual(report.violations, []);
    assert.equal(report.cycles.length, 1);
    assert.equal(defined(report.cycles[0]).kind, 'module-cycle');
    assert.deepEqual([...new Set(defined(report.cycles[0]).path)].sort(), [
      'packages/domain/src/a.ts',
      'packages/domain/src/b.ts',
    ]);
  });

  it('fails closed on an unclassified member', async () => {
    ws.member('packages/brand-new');
    const report = await ws.check();
    assert.deepEqual(
      report.violations.map((v) => `${v.kind} ${v.from}`),
      ['unclassified packages/brand-new/package.json'],
    );
    assert.match(defined(report.violations[0]).message, /ELEMENT_TYPES/);
  });

  it('reports unknown @blackwing packages declared in package.json', async () => {
    ws.member('apps/api', { dependencies: { '@blackwing/ghost': 'workspace:*' } });
    const report = await ws.check();
    assert.deepEqual(
      report.violations.map((v) => `${v.rule} ${v.from} ${v.to}`),
      ['manifest-unknown-workspace-package apps/api/package.json @blackwing/ghost'],
    );
  });

  it('keeps the Go module self-contained', async () => {
    const dir = 'apps/egress-gateway';
    const mod = 'github.com/example/repo/apps/egress-gateway';
    ws.write(
      `${dir}/go.mod`,
      [
        `module ${mod}`,
        '',
        'go 1.23.0',
        '',
        'replace github.com/a/b => ../../packages/policy',
        'replace (',
        '\tgithub.com/c/d => ./third_party/d',
        '\tgithub.com/e/f => ../../infra/f // vendored copy',
        '\tgithub.com/g/h => github.com/g/h v1.2.3',
        ')',
        '',
      ].join('\n'),
    );
    ws.write(
      `${dir}/main.go`,
      [
        'package main',
        '',
        'import (',
        '\t"fmt"',
        `\t"${mod}/internal/proxy"`,
        '\tpolicy "github.com/example/repo/packages/policy"',
        ')',
        '',
        'import "github.com/example/repo/apps/api"',
        '',
        'func main() { fmt.Println(proxy.X, policy.Y) }',
        '',
      ].join('\n'),
    );
    ws.write(
      `${dir}/internal/proxy/proxy.go`,
      `package proxy\n\nimport "${mod}/internal/dns"\n\nconst X = 1\n`,
    );
    ws.write(`${dir}/vendor/x/x.go`, 'package x\n\nimport "github.com/example/repo/packages/db"\n');
    const report = await ws.check();
    assert.deepEqual(
      report.violations.map((v) => `${v.rule} ${v.from} ${v.to}`),
      [
        'go-no-import-outside-module apps/egress-gateway/main.go github.com/example/repo/apps/api',
        'go-no-import-outside-module apps/egress-gateway/main.go github.com/example/repo/packages/policy',
        'go-no-replace-outside-module apps/egress-gateway/go.mod ../../infra/f',
        'go-no-replace-outside-module apps/egress-gateway/go.mod ../../packages/policy',
      ],
    );
    assert.ok(report.violations.every((v) => v.kind === 'go' && v.fromType === 'go-service'));
  });

  it('accepts the real egress-gateway go.mod and Go sources', async () => {
    const goMod = readFileSync(path.join(REPO_ROOT, 'apps/egress-gateway/go.mod'), 'utf8');
    ws.write('apps/egress-gateway/go.mod', goMod);
    ws.write(
      'apps/egress-gateway/main.go',
      readFileSync(path.join(REPO_ROOT, 'apps/egress-gateway/main.go'), 'utf8'),
    );
    const report = await ws.check();
    assert.deepEqual(report.violations, []);
  });

  it('fails when the generated dependency graph doc is missing or stale, and --write-docs fixes it', async () => {
    let report = await ws.check({});
    assert.deepEqual(
      report.violations.map((v) => `${v.kind} ${v.rule}`),
      ['docs docs-up-to-date'],
    );
    assert.match(defined(report.violations[0]).message, /missing/);
    ws.write(DOC_FILE, `${renderDependencyGraphDoc()}hand edit\n`);
    report = await ws.check({});
    assert.match(defined(report.violations[0]).message, /stale.*pnpm boundaries:docs/);

    const { code, stdout } = await capture(() => main(['--root', ws.root, '--write-docs']));
    assert.equal(code, 0, stdout);
    assert.equal(readFileSync(path.join(ws.root, DOC_FILE), 'utf8'), renderDependencyGraphDoc());
    report = await ws.check({});
    assert.equal(report.ok, true);
  });

  it('writes a JSON report for CI annotation', async () => {
    ws.write(DOC_FILE, renderDependencyGraphDoc());
    ws.depend('packages/policy', 'packages/db');
    ws.write('packages/policy/src/x.ts', "export { name } from '@blackwing/db';\n");
    const out = path.join(ws.root, 'boundaries-report.json');
    const { code } = await capture(() => main(['--root', ws.root, '--json', out, '--quiet']));
    assert.equal(code, 1);
    const report = parseJsonObject(readFileSync(out, 'utf8'));
    assert.equal(report.ok, false);
    const violations = asArray(report.violations).map((v) => asObject(v));
    const edge = violations.find((v) => v.from === 'packages/policy/src/x.ts');
    assert.deepEqual(edge, {
      kind: 'boundary',
      rule: 'policy-not-to-service-lib',
      from: 'packages/policy/src/x.ts',
      to: 'packages/db/src/index.ts',
      specifier: '@blackwing/db',
      fromMember: 'packages/policy',
      fromType: 'policy',
      toMember: 'packages/db',
      toType: 'service-lib',
      via: [],
      message:
        'policy packages/policy may not depend on service-lib packages/db (policy may import contracts, shared-lib): packages/policy/src/x.ts -> packages/db/src/index.ts',
    });
    for (const v of violations) assert.ok(VIOLATION_KINDS.includes(String(v.kind)));
    assert.deepEqual(asArray(report.cycles), []);
    const summary = asObject(report.summary);
    assert.equal(summary.violations, violations.length);

    // Workflow-command annotations, with properties escaped.
    const annotations = formatAnnotations(
      /** @type {BoundaryReport} */ (/** @type {unknown} */ (report)),
    ).split('\n');
    assert.ok(
      annotations.includes(
        '::error file=packages/policy/src/x.ts,title=boundaries policy-not-to-service-lib::policy packages/policy may not depend on service-lib packages/db (policy may import contracts, shared-lib): packages/policy/src/x.ts -> packages/db/src/index.ts',
      ),
      annotations.join('\n'),
    );
  });

  it('prints GitHub annotations under GitHub Actions and JSON on stdout with --json -', async () => {
    ws.write(DOC_FILE, renderDependencyGraphDoc());
    ws.depend('packages/domain', 'packages/policy');
    ws.write('packages/domain/src/x.ts', "export { name } from '@blackwing/policy';\n");
    const previous = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = 'true';
    try {
      const { code, stdout } = await capture(() => main(['--root', ws.root]));
      assert.equal(code, 1);
      assert.match(
        stdout,
        /^::error file=packages\/domain\/src\/x\.ts,title=boundaries domain-not-to-policy::/m,
      );
    } finally {
      if (previous === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = previous;
    }
    const { stdout } = await capture(() => main(['--root', ws.root, '--json', '-']));
    assert.equal(parseJsonObject(stdout.slice(0, stdout.lastIndexOf('}') + 1)).ok, false);
  });
});

describe('command line', () => {
  after(() => {
    process.exitCode = 0;
  });

  it('rejects unknown arguments and missing values with exit code 2', async () => {
    for (const argv of [['--bogus'], ['--json'], ['--root']]) {
      const { code, stderr } = await capture(() => main(argv));
      assert.equal(code, 2, argv.join(' '));
      assert.match(stderr, /check-boundaries:/);
    }
  });

  it('parses its options', () => {
    assert.deepEqual(parseArgs(['--root', '/x', '--json', 'r.json', '--write-docs', '--quiet']), {
      root: path.resolve('/x'),
      json: 'r.json',
      writeDocs: true,
      quiet: true,
    });
    assert.equal(parseArgs([]).root, REPO_ROOT);
  });
});
