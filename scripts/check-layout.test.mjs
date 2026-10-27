import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  EXPECTED_APPS,
  EXPECTED_PACKAGES,
  checkLayout,
  exportsConst,
  parseWorkspaceGlobs,
} from './check-layout.mjs';
import {
  REPO_ROOT,
  SCRIPTS_DIR,
  asArray,
  asObject,
  cleanEnv,
  makeValidFixture,
  parseJsonObject,
  readJsonObject,
  writeJson,
  writeMember,
} from './test-fixtures.mjs';

const CHECK_LAYOUT = path.join(SCRIPTS_DIR, 'check-layout.mjs');

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

describe('check-layout against this repository', () => {
  it('passes and reports exactly the CONTEXT_PACK §6 member set (9 apps + 27 packages)', () => {
    const result = checkLayout(REPO_ROOT);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.deepEqual(result.counts, { apps: 9, packages: 27 });
    const names = result.members.map((m) => m.name).sort();
    const expected = [...EXPECTED_APPS, ...EXPECTED_PACKAGES].map((d) => `@blackwing/${d}`).sort();
    assert.deepEqual(names, expected);
    assert.ok(result.members.every((m) => m.private));
  });

  it('pins the expected member lists themselves (guards against silent edits)', () => {
    assert.deepEqual([...EXPECTED_APPS].sort(), [
      'agent-runtime',
      'api',
      'cli',
      'egress-gateway',
      'model-gateway',
      'sandbox-controller',
      'session-manager',
      'web',
      'worker',
    ]);
    assert.deepEqual([...EXPECTED_PACKAGES].sort(), [
      'agents',
      'audit',
      'config',
      'connectors',
      'contracts',
      'cost',
      'crypto',
      'db',
      'domain',
      'errors',
      'events',
      'evidence',
      'ids',
      'logger',
      'mcp-tools',
      'memory',
      'notify',
      'oob',
      'policy',
      'replay',
      'reporting',
      'secrets',
      'telemetry',
      'testing',
      'time',
      'ui',
      'workflow-shared',
    ]);
  });

  it('has a committed pnpm-lock.yaml', () => {
    assert.ok(existsSync(path.join(REPO_ROOT, 'pnpm-lock.yaml')));
  });

  it('every member exports `name` matching its package.json from src/index.ts', () => {
    for (const dir of [
      ...EXPECTED_APPS.map((a) => `apps/${a}`),
      ...EXPECTED_PACKAGES.map((p) => `packages/${p}`),
    ]) {
      const manifest = readJsonObject(path.join(REPO_ROOT, dir, 'package.json'));
      assert.ok(typeof manifest.name === 'string' && typeof manifest.version === 'string', dir);
      const index = readFileSync(path.join(REPO_ROOT, dir, 'src', 'index.ts'), 'utf8');
      assert.ok(exportsConst(index, 'name', manifest.name), dir);
      assert.ok(exportsConst(index, 'version', manifest.version), dir);
    }
  });
});

describe('exportsConst', () => {
  it('accepts single (Prettier) and double quotes', () => {
    assert.equal(
      exportsConst("export const name = '@blackwing/ui';\n", 'name', '@blackwing/ui'),
      true,
    );
    assert.equal(
      exportsConst('export const name = "@blackwing/ui";\n', 'name', '@blackwing/ui'),
      true,
    );
  });

  it('rejects another binding, another value or mismatched quotes', () => {
    assert.equal(
      exportsConst("export const nom = '@blackwing/ui';", 'name', '@blackwing/ui'),
      false,
    );
    assert.equal(
      exportsConst("export const name = '@blackwing/db';", 'name', '@blackwing/ui'),
      false,
    );
    assert.equal(
      exportsConst('export const name = \'@blackwing/ui";', 'name', '@blackwing/ui'),
      false,
    );
  });
});

describe('check-layout on fixtures', () => {
  /** @type {{ root: string, cleanup: () => void }} */
  let fixture;
  beforeEach(() => {
    fixture = makeValidFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it('accepts a valid layout', () => {
    const result = checkLayout(fixture.root);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.counts, { apps: 9, packages: 27 });
  });

  it('detects a duplicate package name across members', () => {
    writeMember(fixture.root, 'packages/logger', { name: '@blackwing/config' });
    const { errors } = checkLayout(fixture.root);
    assertError(
      errors,
      /duplicate package name "@blackwing\/config" in: packages\/config, packages\/logger/,
    );
  });

  it('detects a member without a package.json', () => {
    rmSync(path.join(fixture.root, 'packages/audit/package.json'));
    assertError(checkLayout(fixture.root).errors, /^packages\/audit\/package\.json: missing$/);
  });

  it('detects a package.json without a name', () => {
    writeJson(path.join(fixture.root, 'apps/cli/package.json'), {
      version: '0.0.0',
      private: true,
    });
    assertError(checkLayout(fixture.root).errors, /apps\/cli\/package\.json: "name" is missing/);
  });

  it('detects an unparsable package.json', () => {
    writeFileSync(path.join(fixture.root, 'apps/cli/package.json'), '{ not json');
    assertError(checkLayout(fixture.root).errors, /apps\/cli\/package\.json: invalid JSON/);
  });

  it('detects a name that does not match @blackwing/<dir>', () => {
    writeMember(fixture.root, 'packages/db', { name: 'db' });
    assertError(
      checkLayout(fixture.root).errors,
      /packages\/db\/package\.json: "name" is "db", expected "@blackwing\/db"/,
    );
  });

  it('requires apps to be private', () => {
    writeMember(fixture.root, 'apps/web', { private: false });
    assertError(
      checkLayout(fixture.root).errors,
      /apps\/web\/package\.json: "private" must be true/,
    );
  });

  it('detects a missing src/index.ts or a missing name export', () => {
    rmSync(path.join(fixture.root, 'packages/ui/src/index.ts'));
    writeFileSync(path.join(fixture.root, 'packages/oob/src/index.ts'), 'export const nom = 1;\n');
    const { errors } = checkLayout(fixture.root);
    assertError(errors, /packages\/ui\/src\/index\.ts: missing/);
    assertError(errors, /packages\/oob\/src\/index\.ts: must export/);
  });

  it('detects a missing app directory', () => {
    rmSync(path.join(fixture.root, 'apps/session-manager'), { recursive: true });
    assertError(checkLayout(fixture.root).errors, /apps\/session-manager: missing/);
  });

  it('detects drift: an unexpected package directory', () => {
    writeMember(fixture.root, 'packages/extra');
    assertError(checkLayout(fixture.root).errors, /packages\/extra: unexpected entry/);
  });

  it('detects drift in fixed directories (infra, eval, docs)', () => {
    rmSync(path.join(fixture.root, 'infra/k3s'), { recursive: true });
    mkdirSync(path.join(fixture.root, 'eval/scratch'));
    renameSync(path.join(fixture.root, 'docs/user'), path.join(fixture.root, 'docs/users'));
    const { errors } = checkLayout(fixture.root);
    assertError(errors, /infra\/k3s: missing/);
    assertError(errors, /eval\/scratch: unexpected entry/);
    assertError(errors, /docs\/user: missing/);
    assertError(errors, /docs\/users: unexpected entry/);
  });

  it('requires the .github templates, CODEOWNERS and labels.yml and rejects unknown entries', () => {
    assert.deepEqual(checkLayout(fixture.root).errors, []);
    writeFileSync(path.join(fixture.root, '.github/random.txt'), 'x\n');
    rmSync(path.join(fixture.root, '.github/workflows'), { recursive: true });
    rmSync(path.join(fixture.root, '.github/CODEOWNERS'));
    rmSync(path.join(fixture.root, '.github/labels.yml'));
    const { errors } = checkLayout(fixture.root);
    assertError(errors, /\.github\/random\.txt: unexpected entry/);
    assertError(errors, /\.github\/workflows: missing/);
    assertError(errors, /\.github\/CODEOWNERS: missing/);
    assertError(errors, /\.github\/labels\.yml: missing/);
  });

  it('requires docs/labels.md as a file and still rejects other files in fixed directories', () => {
    rmSync(path.join(fixture.root, 'docs/labels.md'));
    writeFileSync(path.join(fixture.root, 'docs/notes.md'), 'x\n');
    let { errors } = checkLayout(fixture.root);
    assertError(errors, /docs\/labels\.md: missing/);
    assertError(errors, /docs\/notes\.md: unexpected entry/);
    mkdirSync(path.join(fixture.root, 'docs/labels.md'));
    ({ errors } = checkLayout(fixture.root));
    assertError(errors, /docs\/labels\.md: must be a file/);
  });

  it('rejects .github entries of the wrong kind (file vs directory)', () => {
    rmSync(path.join(fixture.root, '.github/ISSUE_TEMPLATE'), { recursive: true });
    writeFileSync(path.join(fixture.root, '.github/ISSUE_TEMPLATE'), 'x\n');
    rmSync(path.join(fixture.root, '.github/PULL_REQUEST_TEMPLATE.md'));
    mkdirSync(path.join(fixture.root, '.github/PULL_REQUEST_TEMPLATE.md'));
    const { errors } = checkLayout(fixture.root);
    assertError(errors, /\.github\/ISSUE_TEMPLATE: must be a directory/);
    assertError(errors, /\.github\/PULL_REQUEST_TEMPLATE\.md: must be a file/);
  });

  it('rejects non-lowercase directory names (case-insensitive filesystems)', () => {
    writeMember(fixture.root, 'packages/Logger');
    const { errors } = checkLayout(fixture.root);
    assertError(errors, /packages\/Logger: directory names must be lowercase kebab-case/);
    // On a case-sensitive filesystem both entries exist and must be reported as a collision.
    if (
      existsSync(path.join(fixture.root, 'packages/logger')) &&
      existsSync(path.join(fixture.root, 'packages/Logger'))
    ) {
      assertError(
        errors,
        /packages: "Logger" and "logger" collide on case-insensitive filesystems/,
      );
    }
  });

  it('detects missing root files', () => {
    rmSync(path.join(fixture.root, 'SECURITY.md'));
    rmSync(path.join(fixture.root, 'LICENSE'));
    rmSync(path.join(fixture.root, 'turbo.json'));
    const { errors } = checkLayout(fixture.root);
    assertError(errors, /^SECURITY\.md: missing at repository root$/);
    assertError(errors, /^LICENSE: missing at repository root$/);
    assertError(errors, /^turbo\.json: missing at repository root$/);
  });

  it('enforces the root package.json contract (engines, packageManager, preinstall, private)', () => {
    writeJson(path.join(fixture.root, 'package.json'), {
      private: false,
      packageManager: 'pnpm@8.15.0',
      engines: { node: '>=20' },
      scripts: {},
    });
    const { errors } = checkLayout(fixture.root);
    assertError(errors, /"private" must be true/);
    assertError(errors, /"packageManager" must pin a pnpm 9\.x version/);
    assertError(errors, /"engines\.node" must be ">=22 <23"/);
    assertError(errors, /"scripts\.preinstall" must run scripts\/preinstall\.mjs/);
  });

  it('rejects workspace globs other than apps/* and packages/*', () => {
    writeFileSync(
      path.join(fixture.root, 'pnpm-workspace.yaml'),
      'packages:\n  - "apps/*"\n  - "packages/*"\n  - "apps/egress-gateway/**"\n',
    );
    assertError(checkLayout(fixture.root).errors, /pnpm-workspace\.yaml: packages must be exactly/);
  });
});

describe('parseWorkspaceGlobs', () => {
  it('parses quoted, unquoted and commented entries and stops at the next key', () => {
    const text =
      '# header\npackages:\n  - "apps/*"\n  # comment\n  - packages/*  # trailing\n\ncatalog:\n  vitest: 1.0.0\n';
    assert.deepEqual(parseWorkspaceGlobs(text), ['apps/*', 'packages/*']);
  });

  it('returns null when there is no packages key', () => {
    assert.equal(parseWorkspaceGlobs('catalog:\n  x: 1\n'), null);
  });

  it("parses this repository's pnpm-workspace.yaml", () => {
    const text = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
    assert.deepEqual(parseWorkspaceGlobs(text), ['apps/*', 'packages/*']);
  });
});

describe('check-layout CLI', () => {
  /** @type {{ root: string, cleanup: () => void }} */
  let fixture;
  beforeEach(() => {
    fixture = makeValidFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it('prints a structured JSON summary and exits 0 on a valid layout', () => {
    const run = spawnSync(process.execPath, [CHECK_LAYOUT, '--root', fixture.root], {
      encoding: 'utf8',
      env: cleanEnv(),
    });
    assert.equal(run.status, 0, run.stderr);
    const summary = parseJsonObject(run.stdout);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.counts, { apps: 9, packages: 27 });
    const members = asArray(summary.members);
    assert.equal(members.length, 36);
    assert.deepEqual(Object.keys(asObject(members[0])).sort(), [
      'dir',
      'kind',
      'name',
      'private',
      'version',
    ]);
  });

  it('exits non-zero with errors in the summary and on stderr when the layout drifts', () => {
    writeMember(fixture.root, 'packages/logger', { name: '@blackwing/config' });
    const run = spawnSync(process.execPath, [CHECK_LAYOUT, '--root', fixture.root], {
      encoding: 'utf8',
      env: cleanEnv(),
    });
    assert.equal(run.status, 1);
    const summary = parseJsonObject(run.stdout);
    assert.equal(summary.ok, false);
    assert.ok(asArray(summary.errors).length > 0);
    assert.match(run.stderr, /duplicate package name "@blackwing\/config"/);
  });

  it('exits 2 on an unknown argument', () => {
    const run = spawnSync(process.execPath, [CHECK_LAYOUT, '--bogus'], {
      encoding: 'utf8',
      env: cleanEnv(),
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown argument: --bogus/);
  });
});
