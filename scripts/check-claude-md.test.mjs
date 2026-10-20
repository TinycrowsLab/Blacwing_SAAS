import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  CLAUDE_MD,
  CONTEXT_PACK,
  MAX_LINES,
  PENDING_LINK_TARGETS,
  REQUIRED_COMMANDS,
  REQUIRED_PACK_SECTIONS,
  REQUIRED_SECTIONS,
  REQUIRED_STATEMENTS,
  checkClaudeMd,
  extractLinks,
  headingAnchors,
  sectionsByHeading,
  slugify,
} from './check-claude-md.mjs';
import { REPO_ROOT, SCRIPTS_DIR, cleanEnv, parseJsonObject } from './test-fixtures.mjs';

const CHECK = path.join(SCRIPTS_DIR, 'check-claude-md.mjs');
const REAL_TEXT = readFileSync(path.join(REPO_ROOT, CLAUDE_MD), 'utf8');
const REAL_PACK = readFileSync(path.join(REPO_ROOT, CONTEXT_PACK), 'utf8');

/** @type {string[]} */
const tempRoots = [];

/**
 * Builds a temporary repository root holding the given files.
 * @param {Record<string, string>} files
 * @returns {string}
 */
function makeRoot(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-claude-md-'));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

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
 * Checks `text` as CLAUDE.md against the real repository.
 * @param {string} text
 */
function check(text) {
  return checkClaudeMd(REPO_ROOT, { text });
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('CLAUDE.md in this repository', () => {
  it('passes every check', () => {
    const result = checkClaudeMd(REPO_ROOT);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.ok(result.linksChecked > 0);
  });

  it('links Context Pack §5, §8 and §10 by heading anchor', () => {
    const { packSectionsLinked } = checkClaudeMd(REPO_ROOT);
    for (const n of REQUIRED_PACK_SECTIONS)
      assert.ok(packSectionsLinked.includes(n), `§${n} not linked`);
    assert.deepEqual([...REQUIRED_PACK_SECTIONS], ['5', '8', '10']);
  });

  it('lists every core pnpm command in the Commands section', () => {
    const commands = sectionsByHeading(REAL_TEXT).get('Commands') ?? '';
    for (const c of ['dev:deps', 'dev', 'test', 'test:int', 'test:e2e', 'lint', 'typecheck']) {
      assert.ok(commands.includes(`\`pnpm ${c}\``), `missing pnpm ${c}`);
    }
    assert.deepEqual([...REQUIRED_COMMANDS].sort(), [
      'pnpm dev',
      'pnpm dev:deps',
      'pnpm lint',
      'pnpm test',
      'pnpm test:e2e',
      'pnpm test:int',
      'pnpm typecheck',
    ]);
  });

  it('links the ADR index (FOUND-015) and the dependency graph (FOUND-005)', () => {
    const links = extractLinks(REAL_TEXT);
    assert.ok(links.includes('docs/adr/README.md'));
    assert.ok(links.includes('docs/architecture/dependency-graph.md'));
  });

  it('contains the explicit never-do list', () => {
    const never = sectionsByHeading(REAL_TEXT).get('Never do') ?? '';
    assert.match(never, /never expose the host docker socket/i);
    assert.match(never, /never call the product "Claude Code"/i);
    assert.match(never, /never add exploit payloads/i);
    assert.match(never, /never weaken a §8 invariant/i);
    assert.match(never, /never log secrets/i);
  });

  it('stays concise', () => {
    assert.ok(REAL_TEXT.split('\n').length <= MAX_LINES);
  });

  it('is free of tool-attribution trailers', () => {
    assert.doesNotMatch(REAL_TEXT, /^Co-Authored-By:/im);
    assert.doesNotMatch(REAL_TEXT, /Generated with/i);
  });
});

describe('slug and Markdown helpers', () => {
  it('follows GitHub heading-slug rules', () => {
    assert.equal(
      slugify('10. Development environment & workflow'),
      '10-development-environment--workflow',
    );
    assert.equal(
      slugify('4.5 Policy & terms constraints (must follow)'),
      '45-policy--terms-constraints-must-follow',
    );
    assert.equal(slugify('3.2 Request → result data flow'), '32-request--result-data-flow');
    assert.equal(slugify('Tables in `packages/db`; tenant_id'), 'tables-in-packagesdb-tenant_id');
    assert.equal(slugify('Ünïcode Größe'), 'ünïcode-größe');
  });

  it('suffixes duplicate heading anchors', () => {
    const anchors = headingAnchors('# Notes\n## Notes\n### Notes\n');
    assert.deepEqual([...anchors], ['notes', 'notes-1', 'notes-2']);
  });

  it('ignores headings and links inside fenced code and inline code', () => {
    const md =
      '# Real\n```\n# Fake\n[x](missing.md)\n```\nSee `[y](also-missing.md)` and [z](z.md).\n';
    assert.deepEqual([...headingAnchors(md)], ['real']);
    assert.deepEqual(extractLinks(md), ['z.md']);
  });
});

describe('CLAUDE.md failure modes', () => {
  it('fails when CLAUDE.md is missing', () => {
    const root = makeRoot({ [CONTEXT_PACK]: REAL_PACK });
    const result = checkClaudeMd(root);
    assert.equal(result.ok, false);
    assertError(result.errors, /CLAUDE\.md: missing at repository root/);
  });

  it('fails when the Context Pack is missing', () => {
    const root = makeRoot({ [CLAUDE_MD]: REAL_TEXT });
    assertError(checkClaudeMd(root).errors, /CONTEXT_PACK\.md: missing/);
  });

  for (const section of REQUIRED_SECTIONS) {
    it(`fails when section "## ${section}" is missing`, () => {
      const text = REAL_TEXT.replace(
        new RegExp(`^## ${escapeRegExp(section)}$`, 'm'),
        `## Renamed ${section}`,
      );
      assertError(check(text).errors, new RegExp(`missing section "## ${escapeRegExp(section)}"`));
    });
  }

  for (const command of REQUIRED_COMMANDS) {
    it(`fails when \`${command}\` is not listed`, () => {
      const text = REAL_TEXT.replaceAll(`\`${command}\``, '`removed`');
      assertError(check(text).errors, new RegExp(`does not list \`${escapeRegExp(command)}\``));
    });
  }

  for (const [section, description, pattern] of REQUIRED_STATEMENTS) {
    it(`fails when "## ${section}" loses the rule: ${description}`, () => {
      const text = REAL_TEXT.replace(new RegExp(pattern.source, `${pattern.flags}g`), '(removed)');
      assertError(
        check(text).errors,
        new RegExp(
          `"## ${escapeRegExp(section)}" is missing the rule: ${escapeRegExp(description)}`,
        ),
      );
    });
  }

  it('fails on a broken relative link', () => {
    const result = check(`${REAL_TEXT}\nSee [gone](docs/architecture/NOPE.md).\n`);
    assertError(result.errors, /broken link "docs\/architecture\/NOPE\.md"/);
  });

  it('fails on an anchor that matches no Context Pack heading', () => {
    const result = check(
      `${REAL_TEXT}\nSee [x](docs/architecture/CONTEXT_PACK.md#99-no-such-section).\n`,
    );
    assertError(result.errors, /matches no heading in docs\/architecture\/CONTEXT_PACK\.md/);
  });

  it('fails on an in-page anchor that matches no CLAUDE.md heading', () => {
    assertError(
      check(`${REAL_TEXT}\n[x](#nowhere)\n`).errors,
      /"#nowhere" matches no heading in CLAUDE\.md/,
    );
    assert.deepEqual(check(`${REAL_TEXT}\n[x](#never-do)\n`).errors, []);
  });

  it('fails on an anchor into a non-Markdown file', () => {
    assertError(check(`${REAL_TEXT}\n[x](package.json#scripts)\n`).errors, /is not Markdown/);
  });

  it('detects drift when a linked Context Pack heading is renamed', () => {
    const pack = REAL_PACK.replace(/^## 8\. Security invariants.*$/m, '## 8. Security rules');
    const root = makeRoot({ [CLAUDE_MD]: REAL_TEXT, [CONTEXT_PACK]: pack, 'SECURITY.md': 'x\n' });
    const { errors } = checkClaudeMd(root);
    assertError(errors, /CONTEXT_PACK\.md#8-security-invariants.*matches no heading/);
    assertError(errors, /must link to docs\/architecture\/CONTEXT_PACK\.md §8/);
  });

  it('fails when a required Context Pack section is no longer linked', () => {
    const text = REAL_TEXT.replaceAll(
      'CONTEXT_PACK.md#10-development-environment--workflow',
      'CONTEXT_PACK.md',
    );
    assertError(check(text).errors, /must link to docs\/architecture\/CONTEXT_PACK\.md §10/);
  });

  it('fails when the ADR index or dependency graph link is dropped', () => {
    const text = REAL_TEXT.replaceAll('(docs/adr/README.md)', '(docs/adr/)').replaceAll(
      '(docs/architecture/dependency-graph.md)',
      '(docs/architecture/)',
    );
    const { errors } = check(text);
    assertError(errors, /must link to docs\/adr\/README\.md/);
    assertError(errors, /must link to docs\/architecture\/dependency-graph\.md/);
  });

  it('allows pending link targets to be missing, then checks them once they exist', () => {
    assert.deepEqual(Object.keys(PENDING_LINK_TARGETS).sort(), ['docs/adr/README.md']);
    const text = `${REAL_TEXT}\n[adr](docs/adr/README.md#index)\n`;
    const base = {
      [CONTEXT_PACK]: REAL_PACK,
      'SECURITY.md': 'x\n',
      'docs/architecture/EPICS.md': '# E\n',
      'docs/architecture/FEATURE_LIST.md': '# F\n',
      'docs/labels.md': '# Labels\n',
      'docs/runbooks/code-owners.md': '# Code owners\n',
      'design/README.md': '# Design\n',
      'docs/architecture/dependency-graph.md': '# Allowed package dependency graph\n',
    };

    const pending = makeRoot({ ...base, [CLAUDE_MD]: text });
    assert.deepEqual(checkClaudeMd(pending).errors, []);

    const landedBad = makeRoot({ ...base, [CLAUDE_MD]: text, 'docs/adr/README.md': '# ADRs\n' });
    assertError(
      checkClaudeMd(landedBad).errors,
      /"docs\/adr\/README\.md#index" matches no heading in docs\/adr\/README\.md/,
    );

    const landedGood = makeRoot({ ...base, [CLAUDE_MD]: text, 'docs/adr/README.md': '# Index\n' });
    assert.deepEqual(checkClaudeMd(landedGood).errors, []);
  });

  it('requires the dependency graph doc now that FOUND-005 (#7) has landed', () => {
    assert.equal(
      Object.hasOwn(PENDING_LINK_TARGETS, 'docs/architecture/dependency-graph.md'),
      false,
    );
    const files = {
      [CONTEXT_PACK]: REAL_PACK,
      [CLAUDE_MD]: REAL_TEXT,
      'SECURITY.md': 'x\n',
      'docs/architecture/EPICS.md': '# E\n',
      'docs/architecture/FEATURE_LIST.md': '# F\n',
      'docs/labels.md': '# Labels\n',
      'docs/runbooks/code-owners.md': '# Code owners\n',
      'design/README.md': '# Design\n',
    };
    assertError(checkClaudeMd(makeRoot(files)).errors, /dependency-graph\.md/);
  });

  it('does not fetch external links', () => {
    const text = `${REAL_TEXT}\n[a](https://example.invalid/x) [b](mailto:security@example.invalid)\n`;
    assert.deepEqual(check(text).errors, []);
  });

  it('rejects absolute and out-of-repository links', () => {
    const { errors } = check(`${REAL_TEXT}\n[a](/etc/passwd) [b](../outside.md)\n`);
    assertError(errors, /"\/etc\/passwd" must be relative/);
    assertError(errors, /"\.\.\/outside\.md" points outside the repository/);
  });

  it('fails on a § reference to a Context Pack section that does not exist', () => {
    assertError(check(`${REAL_TEXT}\nSee §99 and §4.9.\n`).errors, /references §99/);
    assertError(check(`${REAL_TEXT}\nSee §4.9.\n`).errors, /references §4\.9/);
    assert.deepEqual(check(`${REAL_TEXT}\nSee §4.5 and §11.\n`).errors, []);
  });

  it(`fails when CLAUDE.md grows past ${MAX_LINES} lines`, () => {
    const text = `${REAL_TEXT}${'\n'.repeat(MAX_LINES)}`;
    assertError(check(text).errors, new RegExp(`exceeds ${MAX_LINES}`));
  });
});

describe('check-claude-md CLI', () => {
  /**
   * @param {string[]} args
   */
  function run(args) {
    return spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8', env: cleanEnv() });
  }

  it('exits 0 and prints a JSON summary on this repository', () => {
    const res = run([]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(parseJsonObject(res.stdout).ok, true);
  });

  it('exits 1 and names each problem on a broken tree', () => {
    const root = makeRoot({ [CONTEXT_PACK]: REAL_PACK, [CLAUDE_MD]: '# Empty\n' });
    const res = run(['--root', root, '--quiet']);
    assert.equal(res.status, 1);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /missing section "## Never do"/);
  });

  it('exits 2 on bad arguments', () => {
    assert.equal(run(['--bogus']).status, 2);
    assert.equal(run(['--root']).status, 2);
  });
});
