import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { parseDocument } from 'yaml';

import {
  CODEOWNERS,
  CONTEXT_PACK,
  OWNER_REGISTRY,
  PR_SECTIONS,
  PR_TEMPLATE,
  SECURITY_OWNERS,
  TEMPLATE_DIR,
  checkGithub,
  ownersOf,
  packDodItems,
  parseCodeowners,
  parseOwnerRegistry,
  patternToRegExp,
} from './check-github.mjs';
import { MANIFEST_PATH } from './sync-labels.mjs';
import { REPO_ROOT, SCRIPTS_DIR, asObject, cleanEnv } from './test-fixtures.mjs';

const CHECK = path.join(SCRIPTS_DIR, 'check-github.mjs');
const FILES = [
  MANIFEST_PATH,
  `${TEMPLATE_DIR}/task.yml`,
  `${TEMPLATE_DIR}/bug.yml`,
  `${TEMPLATE_DIR}/config.yml`,
  PR_TEMPLATE,
  CODEOWNERS,
  OWNER_REGISTRY,
  CONTEXT_PACK,
];

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
 * @param {string} rel
 * @returns {Record<string, unknown>}
 */
function readForm(rel) {
  return asObject(parseDocument(readFileSync(path.join(REPO_ROOT, rel), 'utf8')).toJS(), rel);
}

describe('GitHub collaboration assets in this repository', () => {
  it('pass every check', () => {
    const result = checkGithub(REPO_ROOT);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it('the CLI exits 0', () => {
    const run = spawnSync(process.execPath, [CHECK, '--quiet'], {
      encoding: 'utf8',
      env: cleanEnv(),
    });
    assert.equal(run.status, 0, run.stderr);
  });

  it('the Task form offers key, epic, area, priority, size, features and depends_on as required fields', () => {
    const form = readForm(`${TEMPLATE_DIR}/task.yml`);
    assert.equal(form.name, 'Task');
    assert.deepEqual(form.labels, ['type:task']);
    const body = /** @type {Array<{ id?: string, validations?: { required?: boolean } }>} */ (
      form.body
    );
    for (const id of ['key', 'epic', 'area', 'priority', 'size', 'features', 'depends_on']) {
      const field = body.find((f) => f.id === id);
      assert.ok(field !== undefined, id);
      assert.equal(field.validations?.required, true, id);
    }
    const ids = body.map((f) => f.id).filter((id) => id !== undefined);
    for (const section of [
      'summary',
      'context',
      'scope',
      'requirements',
      'acceptance',
      'edge_cases',
      'security',
      'observability',
      'test_plan',
      'dependencies',
    ]) {
      assert.ok(ids.includes(section), `CONTEXT_PACK §11 section ${section}`);
    }
  });

  it('blank issues are disabled, so opening a new issue offers the Task template', () => {
    const config = readForm(`${TEMPLATE_DIR}/config.yml`);
    assert.equal(config.blank_issues_enabled, false);
  });

  it('the PR template renders the six sections, the Closes prompt and the §10 DoD checklist', () => {
    const template = readFileSync(path.join(REPO_ROOT, PR_TEMPLATE), 'utf8');
    const headings = [...template.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, [...PR_SECTIONS]);
    assert.match(template, /^Closes #$/m);
    const dod = packDodItems(readFileSync(path.join(REPO_ROOT, CONTEXT_PACK), 'utf8'));
    assert.equal(dod.length, 7);
    for (const item of dod) assert.ok(template.includes(`- [ ] ${item}`), item);
  });

  it('routes the security-owned paths to the security owners and the rest to the maintainers', () => {
    const errors = /** @type {string[]} */ ([]);
    const rules = parseCodeowners(readFileSync(path.join(REPO_ROOT, CODEOWNERS), 'utf8'), errors);
    assert.deepEqual(errors, []);
    for (const file of [
      'apps/egress-gateway/cmd/main.go',
      'packages/policy/src/index.ts',
      'packages/crypto/src/index.ts',
    ]) {
      assert.deepEqual(ownersOf(rules, file), [SECURITY_OWNERS], file);
    }
    for (const file of [
      'apps/web/src/index.ts',
      'packages/policy-ui/x.ts',
      'docs/labels.md',
      '.github/labels.yml',
    ]) {
      assert.deepEqual(ownersOf(rules, file), ['@TinycrowsLab/blackwing-maintainers'], file);
    }
  });

  it('documents every CODEOWNERS owner, marked as a placeholder until the teams exist (#842)', () => {
    const registry = parseOwnerRegistry(readFileSync(path.join(REPO_ROOT, OWNER_REGISTRY), 'utf8'));
    assert.equal(registry.get('@tinycrowslab/blackwing-security-owners'), 'placeholder');
    assert.equal(registry.get('@tinycrowslab/blackwing-maintainers'), 'placeholder');
    assert.match(
      readFileSync(path.join(REPO_ROOT, CODEOWNERS), 'utf8'),
      /OFFLINE-STUB\(online-porting #842\)/,
    );
  });
});

describe('CODEOWNERS pattern matching (gitignore semantics, last match wins)', () => {
  it('anchors patterns with a leading or middle slash and floats the others', () => {
    assert.ok(patternToRegExp('*').test('a/b/c.ts'));
    assert.ok(patternToRegExp('*.md').test('docs/x/readme.md'));
    assert.ok(!patternToRegExp('*.md').test('docs/x/readme.mdx'));
    assert.ok(patternToRegExp('apps/egress-gateway/**').test('apps/egress-gateway/a/b.go'));
    assert.ok(!patternToRegExp('apps/egress-gateway/**').test('x/apps/egress-gateway/a.go'));
    assert.ok(!patternToRegExp('apps/egress-gateway/**').test('apps/egress-gateway-v2/a.go'));
    assert.ok(patternToRegExp('/SECURITY.md').test('SECURITY.md'));
    assert.ok(!patternToRegExp('/SECURITY.md').test('docs/SECURITY.md'));
    assert.ok(patternToRegExp('docs/').test('docs/a/b.md'));
    assert.ok(patternToRegExp('**/fixtures/**').test('packages/db/test/fixtures/a.json'));
    assert.ok(patternToRegExp('/.gitleaks.toml').test('.gitleaks.toml'));
    assert.ok(!patternToRegExp('/.gitleaks.toml').test('xgitleaks.toml'));
  });

  it('gives a file the owners of the last matching rule', () => {
    const rules = parseCodeowners('* @org/a\npackages/** @org/b\npackages/ui/** @org/c\n', []);
    assert.deepEqual(ownersOf(rules, 'packages/ui/x.ts'), ['@org/c']);
    assert.deepEqual(ownersOf(rules, 'packages/db/x.ts'), ['@org/b']);
    assert.deepEqual(ownersOf(rules, 'README.md'), ['@org/a']);
    assert.deepEqual(ownersOf(parseCodeowners('docs/** @org/a\n', []), 'apps/x.ts'), []);
  });
});

describe('check-github on fixtures', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bw-github-'));
    for (const rel of FILES) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      cpSync(path.join(REPO_ROOT, rel), path.join(root, rel));
    }
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * @param {string} rel
   * @param {(text: string) => string} edit
   */
  const edit = (rel, edit) => {
    const file = path.join(root, rel);
    const before = readFileSync(file, 'utf8');
    const after = edit(before);
    assert.notEqual(after, before, `fixture edit of ${rel} changed nothing`);
    writeFileSync(file, after);
  };

  it('a verbatim copy passes', () => {
    assert.deepEqual(checkGithub(root).errors, []);
  });

  it('CODEOWNERS naming a team that is not in the registry fails (unknown owners block or are ignored)', () => {
    edit(CODEOWNERS, (t) =>
      t.replace(
        'packages/policy/**        @TinycrowsLab/blackwing-security-owners',
        'packages/policy/**        @TinycrowsLab/ghost-team',
      ),
    );
    const { errors } = checkGithub(root);
    assertError(errors, /owner "@TinycrowsLab\/ghost-team" is not listed/);
    assertError(
      errors,
      /"packages\/policy\/src\/index\.ts" must be owned by @TinycrowsLab\/blackwing-security-owners/,
    );
  });

  it('placeholder owners without the OFFLINE-STUB marker fail; active owners do not need it', () => {
    edit(CODEOWNERS, (t) => t.replace(/OFFLINE-STUB\(online-porting #842\)/, 'NOTE'));
    assertError(checkGithub(root).errors, /placeholder owners .* no OFFLINE-STUB/);
    edit(OWNER_REGISTRY, (t) => t.replaceAll('| placeholder |', '| active |'));
    assert.deepEqual(checkGithub(root).errors, []);
  });

  it('a later rule that takes a security-owned path away from the security owners fails', () => {
    edit(CODEOWNERS, (t) => `${t}apps/** @TinycrowsLab/blackwing-maintainers\n`);
    assertError(checkGithub(root).errors, /"apps\/egress-gateway\/go\.mod" must be owned by/);
  });

  it('rejects CODEOWNERS syntax GitHub does not support and rules without owners', () => {
    edit(
      CODEOWNERS,
      (t) =>
        `${t}!docs/** @TinycrowsLab/blackwing-maintainers\n[ab].md @TinycrowsLab/blackwing-maintainers\nfoo\\#bar @TinycrowsLab/blackwing-maintainers\nlonely/**\nx @not a valid\n`,
    );
    const { errors } = checkGithub(root);
    assertError(errors, /negation is not supported/);
    assertError(errors, /character ranges are not supported/);
    assertError(errors, /backslash escapes are not supported/);
    assertError(errors, /"lonely\/\*\*" has no owners/);
    assertError(errors, /"valid" is not a valid owner/);
    assertError(errors, /owner "@not" is not listed/);
  });

  it('detects drift between Task dropdowns and the label catalogue', () => {
    edit(`${TEMPLATE_DIR}/task.yml`, (t) =>
      t.replace('        - L\n', '        - L\n        - XL\n').replace('        - LATER\n', ''),
    );
    const { errors } = checkGithub(root);
    assertError(errors, /"size" options drift .* not in the catalogue: XL/);
    assertError(errors, /"epic" options drift .* missing: LATER/);
  });

  it('detects a new label group value that the Task form does not offer', () => {
    edit(MANIFEST_PATH, (t) =>
      t.replace(
        "      - name: 'area:foundations'\n",
        "      - name: 'area:new-area'\n        color: '000000'\n        description: 'Architecture area: New Area'\n      - name: 'area:foundations'\n",
      ),
    );
    assertError(checkGithub(root).errors, /"area" options drift .* missing: area:new-area/);
  });

  it('fails when a template applies a label that is not in the catalogue', () => {
    edit(`${TEMPLATE_DIR}/bug.yml`, (t) =>
      t.replace("labels: ['bug']", "labels: ['bug', 'type:bug']"),
    );
    assertError(checkGithub(root).errors, /applies label "type:bug", which is not in/);
  });

  it('fails when the Task form loses a required metadata field or makes it optional', () => {
    edit(`${TEMPLATE_DIR}/task.yml`, (t) => t.replace('    id: depends_on\n', '    id: depends\n'));
    edit(`${TEMPLATE_DIR}/task.yml`, (t) =>
      t.replace(/(id: features\n(?:.*\n)*?\s+required: )true/, '$1false'),
    );
    const { errors } = checkGithub(root);
    assertError(errors, /missing the "depends_on" field/);
    assertError(errors, /the "features" field must be required/);
  });

  it('enforces GitHub issue-form rules (reserved None, duplicate ids, empty options, bad types)', () => {
    edit(`${TEMPLATE_DIR}/bug.yml`, (t) =>
      t
        .replace('        - No invariant affected\n', '        - None\n')
        .replace('    id: version\n', '    id: component\n')
        .replace('  - type: markdown\n', '  - type: heading\n'),
    );
    const { errors } = checkGithub(root);
    assertError(errors, /"None" is a reserved dropdown option/);
    assertError(errors, /duplicate id "component"/);
    assertError(errors, /"type" must be one of/);
  });

  it('requires blank issues off and a private vulnerability-reporting link', () => {
    edit(`${TEMPLATE_DIR}/config.yml`, (t) =>
      t
        .replace('blank_issues_enabled: false', 'blank_issues_enabled: true')
        .replace('/security/advisories/new', '/issues'),
    );
    const { errors } = checkGithub(root);
    assertError(errors, /blank_issues_enabled must be false/);
    assertError(errors, /private vulnerability reporting/);
  });

  it('fails when the PR template drops a section, the Closes prompt or a DoD item', () => {
    edit(PR_TEMPLATE, (t) =>
      t
        .replace('## Test evidence', '## Testing')
        .replace('Closes #\n', 'Fixes:\n')
        .replace('- [ ] Edge cases listed in the issue have explicit tests.\n', ''),
    );
    const { errors } = checkGithub(root);
    assertError(errors, /sections must be exactly/);
    assertError(errors, /must prompt with a "Closes #" line/);
    assertError(
      errors,
      /missing the §10 item "Edge cases listed in the issue have explicit tests\."/,
    );
  });

  it('fails when the §10 DoD changes and the PR template is not updated', () => {
    edit(CONTEXT_PACK, (t) =>
      t.replace(
        '- [ ] Edge cases listed in the issue have explicit tests.',
        '- [ ] Every listed edge case has a named test.',
      ),
    );
    const { errors } = checkGithub(root);
    assertError(errors, /missing the §10 item "Every listed edge case has a named test\."/);
    assertError(
      errors,
      /"Edge cases listed in the issue have explicit tests\." is not in CONTEXT_PACK §10/,
    );
  });

  it('reports missing files and an invalid label catalogue instead of crashing', () => {
    rmSync(path.join(root, CODEOWNERS));
    rmSync(path.join(root, `${TEMPLATE_DIR}/task.yml`));
    writeFileSync(path.join(root, MANIFEST_PATH), 'version: [\n');
    const { errors } = checkGithub(root);
    assertError(errors, /\.github\/CODEOWNERS: missing/);
    assertError(errors, /task\.yml: missing/);
    assertError(errors, /labels\.yml: invalid YAML/);
  });

  it('the CLI exits 1 with a summary when a check fails', () => {
    rmSync(path.join(root, PR_TEMPLATE));
    const run = spawnSync(process.execPath, [CHECK, '--root', root, '--quiet'], {
      encoding: 'utf8',
      env: cleanEnv(),
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /PULL_REQUEST_TEMPLATE\.md: missing/);
  });
});
