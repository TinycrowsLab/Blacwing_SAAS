// Self-tests for the commit-message gate (FOUND-006, #8): commitlint.config.mjs and the generated
// scope list in scripts/commit-scopes.mjs. Messages are linted with the real configuration, loaded
// the way the `commit-msg` hook loads it. The hooks themselves are exercised end to end in
// scripts/git-hooks.test.mjs.

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import lint from '@commitlint/lint';
import load from '@commitlint/load';

import { COMMIT_SCOPES, COMMIT_TYPES } from '../commitlint.config.mjs';
import { EXPECTED_APPS, EXPECTED_DIRS, EXPECTED_PACKAGES } from './check-layout.mjs';
import {
  REPO_SCOPES,
  allowedScopes,
  epicScopes,
  layoutScopes,
  workspaceScopes,
} from './commit-scopes.mjs';
import { MANIFEST_PATH } from './sync-labels.mjs';
import { REPO_ROOT, makeValidFixture, writeMember } from './test-fixtures.mjs';

/** @type {Awaited<ReturnType<typeof load>>} */
let loaded;

before(async () => {
  loaded = await load({}, { cwd: REPO_ROOT });
});

/**
 * Lints one message with the repository configuration.
 * @param {string} message
 */
async function check(message) {
  // The same options @commitlint/cli derives from a loaded config.
  /** @type {import('@commitlint/types').LintOptions} */
  const opts = { helpUrl: loaded.helpUrl, plugins: loaded.plugins };
  if (loaded.defaultIgnores !== undefined) opts.defaultIgnores = loaded.defaultIgnores;
  const parserOpts = loaded.parserPreset?.parserOpts;
  if (parserOpts !== undefined) {
    opts.parserOpts = /** @type {NonNullable<typeof opts.parserOpts>} */ (parserOpts);
  }
  return lint(message, loaded.rules, opts);
}

/**
 * Names of the rules a message breaks (errors only).
 * @param {string} message
 * @returns {Promise<string[]>}
 */
async function brokenRules(message) {
  const report = await check(message);
  return report.errors.map((e) => e.name).sort();
}

/**
 * @param {string} message
 */
async function assertValid(message) {
  const report = await check(message);
  assert.equal(
    report.valid,
    true,
    `expected "${message}" to pass, got: ${report.errors.map((e) => e.message).join('; ')}`,
  );
}

/**
 * @param {string} message
 * @param {string} rule  a rule the message must break
 */
async function assertInvalid(message, rule) {
  const report = await check(message);
  assert.equal(report.valid, false, `expected "${message}" to be rejected`);
  assert.ok(
    report.errors.some((e) => e.name === rule),
    `expected "${message}" to break ${rule}, got: ${report.errors.map((e) => e.name).join(', ')}`,
  );
}

describe('commitlint config: acceptance criteria', () => {
  it('rejects "bad message" (no type, no subject)', async () => {
    assert.deepEqual(await brokenRules('bad message'), ['subject-empty', 'type-empty']);
  });

  it('accepts "feat(egress): add budget"', async () => {
    await assertValid('feat(egress): add budget');
  });

  it('loads through the conventional preset with a parser that understands scopes', () => {
    assert.ok(loaded.extends.includes('@commitlint/config-conventional'));
    assert.equal(loaded.defaultIgnores, true);
  });
});

describe('commitlint config: type-enum', () => {
  it('allows exactly feat, fix, docs, chore, refactor, test, build, ci, perf and revert', () => {
    assert.deepEqual(
      [...COMMIT_TYPES],
      ['feat', 'fix', 'docs', 'chore', 'refactor', 'test', 'build', 'ci', 'perf', 'revert'],
    );
    assert.deepEqual(loaded.rules['type-enum'], [2, 'always', [...COMMIT_TYPES]]);
  });

  for (const type of COMMIT_TYPES) {
    it(`accepts the "${type}" type`, async () => {
      await assertValid(`${type}: change something`);
    });
  }

  it('rejects a type outside the list ("style", which config-conventional allows)', async () => {
    await assertInvalid('style: reformat', 'type-enum');
  });

  it('rejects an unknown type', async () => {
    await assertInvalid('feature(api): add runs', 'type-enum');
  });

  it('rejects an upper-case type', async () => {
    await assertInvalid('Feat(api): add runs', 'type-case');
  });

  it('accepts a breaking-change marker', async () => {
    await assertValid('feat(api)!: drop the v0 endpoints');
  });
});

describe('commitlint config: scope-enum', () => {
  it('accepts a commit without a scope', async () => {
    await assertValid('chore: tidy the root configs');
  });

  it('accepts every workspace member as a scope', async () => {
    for (const member of [...EXPECTED_APPS, ...EXPECTED_PACKAGES]) {
      await assertValid(`fix(${member}): handle the empty case`);
    }
  });

  it('accepts the existing repository-wide and layout scopes', async () => {
    for (const scope of ['repo', 'deps', 'design', 'scripts', 'infra', 'compose', 'docs', 'adr']) {
      await assertValid(`build(${scope}): adjust`);
    }
  });

  it('rejects a scope that is not generated from the repository', async () => {
    await assertInvalid('feat(payments): add checkout', 'scope-enum');
  });

  it('validates every scope of a multi-scope commit', async () => {
    await assertValid('feat(api,web): add the runs list');
    await assertValid('feat(api/web): add the runs list');
    await assertInvalid('feat(api,payments): add checkout', 'scope-enum');
  });

  it('rejects an upper-case scope', async () => {
    await assertInvalid('feat(API): add runs', 'scope-case');
  });

  it('rejects empty scope parentheses', async () => {
    await assertInvalid('feat(): add runs', 'scope-not-blank');
    await assertInvalid('feat( ): add runs', 'scope-not-blank');
    await assertInvalid('feat()!: drop runs', 'scope-not-blank');
  });
});

describe('commitlint config: header, body and footer', () => {
  it('rejects a header longer than 100 characters', async () => {
    await assertInvalid(`feat(api): ${'x'.repeat(95)}`, 'header-max-length');
  });

  it('rejects a sentence-case subject', async () => {
    await assertInvalid('fix(api): Handle the empty case', 'subject-case');
  });

  it('rejects a subject ending with a full stop', async () => {
    await assertInvalid('fix(api): handle the empty case.', 'subject-full-stop');
  });

  it('rejects a body line longer than 100 characters', async () => {
    await assertInvalid(`fix(api): handle it\n\n${'word '.repeat(25)}`, 'body-max-line-length');
  });

  it('accepts a wrapped body with an issue reference footer', async () => {
    await assertValid(
      'feat(egress-gateway): add request budgets\n\nCounts requests per run and blocks once the\nbudget is spent.\n\nRefs #8',
    );
  });
});

describe('commitlint config: merge commits and reverts', () => {
  for (const message of [
    "Merge branch 'main' into egress-004-request-budgets",
    "Merge branch 'egress-004-request-budgets'",
    'Merge pull request #12 from TinycrowsLab/egress-004-request-budgets',
    "Merge remote-tracking branch 'origin/main'",
    "Merge tag 'v1.0.0'",
  ]) {
    it(`exempts the git merge message "${message}"`, async () => {
      await assertValid(message);
    });
  }

  it("exempts git's own revert message", async () => {
    await assertValid(
      'Revert "feat(api): add runs"\n\nThis reverts commit 1743d87bd2b0c4a0dd3ab7e0e7c0f2c3d4e5f6a7.',
    );
  });

  it('accepts a conventional revert', async () => {
    await assertValid('revert: feat(api): add runs\n\nThis reverts commit 1743d87.');
  });

  it('does not exempt a message that only mentions merging', async () => {
    await assertInvalid('merged the budget branch', 'type-empty');
  });
});

describe('commit scopes: generated from the repository', () => {
  it('is sorted, de-duplicated lowercase kebab-case', () => {
    assert.deepEqual([...COMMIT_SCOPES], [...new Set(COMMIT_SCOPES)].sort());
    for (const scope of COMMIT_SCOPES) assert.match(scope, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.deepEqual([...COMMIT_SCOPES], allowedScopes(REPO_ROOT));
  });

  it('holds every workspace member by directory name', () => {
    assert.deepEqual(
      workspaceScopes(REPO_ROOT).sort(),
      [...EXPECTED_APPS, ...EXPECTED_PACKAGES].sort(),
    );
  });

  it('holds every epic key from the label catalogue, lowercased', () => {
    const epics = epicScopes(REPO_ROOT);
    assert.ok(epics.length > 0);
    for (const key of ['found', 'egress', 'ci', 'devenv', 'sandbox'])
      assert.ok(epics.includes(key));
    for (const epic of epics) assert.ok(COMMIT_SCOPES.includes(epic));
  });

  it('holds the fixed layout directories and the repository-wide scopes', () => {
    for (const [dir, children] of Object.entries(EXPECTED_DIRS)) {
      assert.ok(layoutScopes().includes(dir));
      for (const child of children) assert.ok(COMMIT_SCOPES.includes(child));
    }
    for (const scope of REPO_SCOPES) assert.ok(COMMIT_SCOPES.includes(scope));
  });
});

describe('commit scopes: fixture repositories', () => {
  /** @type {{ root: string, cleanup: () => void }} */
  let fixture;

  beforeEach(() => {
    fixture = makeValidFixture();
    mkdirSync(path.join(fixture.root, '.github'), { recursive: true });
    copyFileSync(path.join(REPO_ROOT, MANIFEST_PATH), path.join(fixture.root, MANIFEST_PATH));
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('picks up a new workspace member without any config change', () => {
    assert.ok(!allowedScopes(fixture.root).includes('billing'));
    writeMember(fixture.root, 'packages/billing');
    assert.ok(allowedScopes(fixture.root).includes('billing'));
  });

  it('ignores a directory without a package.json', () => {
    mkdirSync(path.join(fixture.root, 'packages', 'scratch'));
    assert.ok(!workspaceScopes(fixture.root).includes('scratch'));
  });

  it('fails loudly when a member is misnamed', () => {
    writeMember(fixture.root, 'packages/billing', { name: '@other/billing' });
    assert.throws(() => workspaceScopes(fixture.root), /must be "@blackwing\/billing"/);
  });

  it('fails loudly when pnpm-workspace.yaml has no packages list', () => {
    writeFileSync(path.join(fixture.root, 'pnpm-workspace.yaml'), 'catalog: {}\n');
    assert.throws(() => allowedScopes(fixture.root), /no "packages:" list/);
  });

  it('fails loudly on a workspace glob it cannot expand', () => {
    writeFileSync(path.join(fixture.root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/**"\n');
    assert.throws(() => allowedScopes(fixture.root), /unsupported workspace glob/);
  });

  it('fails loudly when the label catalogue is missing', () => {
    rmSync(path.join(fixture.root, MANIFEST_PATH));
    assert.throws(() => allowedScopes(fixture.root), /labels\.yml: cannot derive commit scopes/);
  });

  it('fails loudly when the label catalogue is invalid', () => {
    writeFileSync(path.join(fixture.root, MANIFEST_PATH), 'version: 1\ngroups: [\n');
    assert.throws(() => allowedScopes(fixture.root), /invalid YAML/);
  });

  it('fails loudly when the label catalogue has no epic group', () => {
    writeFileSync(
      path.join(fixture.root, MANIFEST_PATH),
      [
        'version: 1',
        'groups:',
        '  - id: type',
        "    title: 'Type'",
        "    description: 'Kind of work'",
        "    prefix: 'type:'",
        '    labels:',
        "      - name: 'type:task'",
        "        color: '5319E7'",
        "        description: 'A task'",
        '',
      ].join('\n'),
    );
    assert.throws(() => allowedScopes(fixture.root), /no "epic" label group/);
  });
});
