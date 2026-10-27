import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  ADR_DIR,
  CONTEXT_PACK,
  INDEX_FILE,
  MAX_ADR_LINES,
  REQUIRED_SECTIONS,
  STATUS_VALUES,
  TEMPLATE_FILE,
  checkAdrs,
  lintMarkdown,
  packAnchorSections,
  packSectionNumbers,
  sectionReferences,
  sortSections,
  stripLinks,
} from './check-adr.mjs';
import { REPO_ROOT, SCRIPTS_DIR, cleanEnv, parseJsonObject } from './test-fixtures.mjs';

const CHECK = path.join(SCRIPTS_DIR, 'check-adr.mjs');
const REAL_PACK = readFileSync(path.join(REPO_ROOT, CONTEXT_PACK), 'utf8');
const PACK_LINK = '../architecture/CONTEXT_PACK.md';
const STACK_ANCHOR =
  '5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage';
const INVARIANTS_ANCHOR =
  '8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch';
const TEMPORAL_ADR = '0005-temporal-run-lifecycle.md';

/** The decisions FOUND-015 (#17) records, in order. */
const INITIAL_ADRS = Object.freeze([
  '0001-record-architecture-decisions.md',
  '0002-pnpm-turborepo-monorepo.md',
  '0003-strict-typescript-zod-contracts.md',
  '0004-nestjs-fastify-rest-graphql-api.md',
  TEMPORAL_ADR,
  '0006-claude-agent-sdk-claude-only-models.md',
  '0007-cedar-policy-decision-point.md',
  '0008-go-egress-gateway-fail-closed.md',
  '0009-openbao-secrets-byok.md',
  '0010-postgres-rls-multi-tenancy.md',
  '0011-gvisor-sandboxes-on-k3s.md',
]);

/** @type {string[]} */
const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Copies the real docs/adr/ and Context Pack into a temporary repository root.
 * @returns {string}
 */
function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-adr-'));
  tempRoots.push(root);
  cpSync(path.join(REPO_ROOT, ADR_DIR), path.join(root, ADR_DIR), { recursive: true });
  mkdirSync(path.dirname(path.join(root, CONTEXT_PACK)), { recursive: true });
  writeFileSync(path.join(root, CONTEXT_PACK), REAL_PACK);
  // ADRs link to sibling architecture docs; copy them so the link check sees real targets.
  const archDir = path.dirname(CONTEXT_PACK);
  for (const doc of readdirSync(path.join(REPO_ROOT, archDir)).filter((f) => f.endsWith('.md'))) {
    if (doc !== path.basename(CONTEXT_PACK))
      cpSync(path.join(REPO_ROOT, archDir, doc), path.join(root, archDir, doc));
  }
  return root;
}

/**
 * @param {string} root
 * @param {string} file  path inside docs/adr/
 * @returns {string}
 */
function read(root, file) {
  return readFileSync(path.join(root, ADR_DIR, file), 'utf8');
}

/**
 * @param {string} root
 * @param {string} file  path inside docs/adr/
 * @param {string} text
 */
function write(root, file, text) {
  writeFileSync(path.join(root, ADR_DIR, file), text);
}

/**
 * Applies a text replacement to a docs/adr/ file, failing when the search text is absent.
 * @param {string} root
 * @param {string} file
 * @param {string} from
 * @param {string} to
 */
function replaceIn(root, file, from, to) {
  const text = read(root, file);
  assert.ok(text.includes(from), `${file} must contain ${JSON.stringify(from)}`);
  write(root, file, text.replace(from, to));
}

/**
 * A minimal valid ADR.
 * @param {string} number
 * @param {string} title
 * @param {string} status  body of the Status section
 * @returns {string}
 */
function adrText(number, title, status = 'Accepted') {
  return [
    `# ADR-${number}: ${title}`,
    '',
    'Date: 2026-10-21',
    '',
    '## Status',
    '',
    status,
    '',
    '## Context',
    '',
    'Why.',
    '',
    '## Decision',
    '',
    'What.',
    '',
    '## Consequences',
    '',
    'Then.',
    '',
    '## References',
    '',
    `- [Context Pack §5](${PACK_LINK}#${STACK_ANCHOR}).`,
    '',
  ].join('\n');
}

/**
 * Appends an index row for a new ADR.
 * @param {string} root
 * @param {string} row
 */
function addIndexRow(root, row) {
  replaceIn(
    root,
    INDEX_FILE,
    '| Accepted | §1.1, §4.1, §5, §8 |\n',
    `| Accepted | §1.1, §4.1, §5, §8 |\n${row}\n`,
  );
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function errorsOf(root) {
  return checkAdrs(root).errors;
}

/**
 * @param {string[]} errors
 * @param {RegExp} pattern
 */
function assertError(errors, pattern) {
  assert.ok(
    errors.some((e) => pattern.test(e)),
    `expected an error matching ${pattern}, got:\n${errors.join('\n')}`,
  );
}

describe('check-adr: the repository', () => {
  it('passes on the committed ADRs', () => {
    const result = checkAdrs(REPO_ROOT);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it('records ADRs 0001 to 0011, each Accepted or superseded by a later ADR', () => {
    const { adrs } = checkAdrs(REPO_ROOT);
    const numbers = adrs.map((a) => a.number);
    for (const file of INITIAL_ADRS) {
      const number = file.slice(0, 4);
      assert.ok(numbers.includes(number), `${file} is missing`);
      const adr = adrs.find((a) => a.number === number);
      assert.ok(
        adr?.status === 'Accepted' || adr?.status.startsWith('Superseded by ADR-') === true,
        `${file} has status ${adr?.status ?? 'none'}`,
      );
      assert.match(read(REPO_ROOT, file), new RegExp(`^# ADR-${number}: `));
    }
  });

  it('cites at least one Context Pack heading from every ADR', () => {
    for (const adr of checkAdrs(REPO_ROOT).adrs) {
      assert.ok(adr.cites.length > 0, `ADR-${adr.number} cites no Context Pack heading`);
    }
  });

  it('ties the security-critical ADRs (0008, 0010, 0011) to the §8 invariants', () => {
    const { adrs } = checkAdrs(REPO_ROOT);
    for (const number of ['0008', '0010', '0011']) {
      const adr = adrs.find((a) => a.number === number);
      assert.ok(adr?.cites.includes(INVARIANTS_ANCHOR), `ADR-${number} must cite §8`);
    }
  });

  it('has a template with every required section', () => {
    const template = read(REPO_ROOT, TEMPLATE_FILE);
    for (const section of REQUIRED_SECTIONS) assert.ok(template.includes(`\n## ${section}\n`));
  });
});

describe('check-adr: Context Pack sections', () => {
  it('knows numbered headings and the numbered items of §8', () => {
    const numbers = packSectionNumbers(REAL_PACK);
    for (const n of ['1.1', '4.5', '5', '8', '8.1', '8.2', '8.6', '8.11', '10', '11']) {
      assert.ok(numbers.has(n), `§${n} should exist`);
    }
    for (const n of ['8.12', '4.9', '12', '99'])
      assert.ok(!numbers.has(n), `§${n} should not exist`);
  });

  it('ignores ordered lists inside code fences and lists under unnumbered headings', () => {
    const numbers = packSectionNumbers(
      '# T\n\n## 2. Two\n\n```\n1. fenced\n```\n\n### Notes\n\n1. under an unnumbered heading\n',
    );
    assert.deepEqual([...numbers].sort(), ['2']);
  });

  it('maps unnumbered headings to the enclosing numbered section', () => {
    const sections = packAnchorSections(REAL_PACK);
    assert.equal(sections.get('definition-of-done-applies-to-every-issue'), '10');
    assert.equal(sections.get('41-topology'), '4.1');
  });

  it('extracts § references outside code fences and sorts them numerically', () => {
    assert.deepEqual(sectionReferences('See §8.2, § 5 and §10.\n```\n§99\n```\n'), [
      '8.2',
      '5',
      '10',
    ]);
    assert.deepEqual(sortSections(['10', '4.5', '4', '8.11', '8.2', '4']), [
      '4',
      '4.5',
      '8.2',
      '8.11',
      '10',
    ]);
    assert.equal(stripLinks('Superseded by [ADR-0012](0012-x.md)'), 'Superseded by ADR-0012');
  });
});

describe('check-adr: Markdown lint', () => {
  const good = '# Title\n\nText.\n\n## Section\n\n- item\n';

  it('accepts well-formed Markdown', () => {
    assert.deepEqual(lintMarkdown(good, 'x.md'), []);
  });

  /** @type {Array<[string, string, RegExp]>} */
  const cases = [
    ['trailing whitespace', good.replace('Text.', 'Text.  '), /trailing whitespace/],
    ['hard tab', good.replace('- item', '-\titem'), /hard tab/],
    ['CRLF', good.replace(/\n/g, '\r\n'), /CRLF/],
    ['missing final newline', good.slice(0, -1), /exactly one newline/],
    ['extra final newline', `${good}\n`, /exactly one newline/],
    ['consecutive blank lines', good.replace('Text.\n', 'Text.\n\n'), /consecutive blank lines/],
    ['no first-line H1', `Intro\n\n${good}`, /first line must be a level-1 heading/],
    ['second H1', `${good}\n# Again\n`, /2 level-1 headings/],
    ['heading jump', good.replace('## Section', '### Section'), /jumps from level 1 to 3/],
    ['no blank before heading', good.replace('Text.\n\n##', 'Text.\n##'), /blank line before/],
    ['no blank after heading', good.replace('## Section\n\n', '## Section\n'), /blank line after/],
    ['no space after #', good.replace('## Section', '##Section'), /no space after heading marker/],
    ['unclosed fence', `${good}\n\`\`\`\ncode\n`, /code fence is never closed/],
  ];
  for (const [name, text, pattern] of cases) {
    it(`flags ${name}`, () => {
      assertError(lintMarkdown(text, 'x.md'), pattern);
    });
  }

  it('does not lint inside code fences', () => {
    const text = `${good}\n\`\`\`\n#not-a-heading\n\n\n\`\`\`\n`;
    assert.deepEqual(lintMarkdown(text, 'x.md'), []);
  });

  it('lints the committed ADR files (via checkAdrs)', () => {
    const root = makeRoot();
    replaceIn(root, TEMPORAL_ADR, '## Decision\n', '## Decision   \n');
    assertError(errorsOf(root), /0005-temporal-run-lifecycle\.md:\d+: trailing whitespace/);
  });
});

describe('check-adr: ADR files', () => {
  it('flags unexpected entries and malformed file names', () => {
    const root = makeRoot();
    write(root, 'notes.txt', 'x\n');
    write(root, '12-short-number.md', adrText('0012', 'Short number'));
    write(root, '0012-Upper-Case.md', adrText('0012', 'Upper case'));
    mkdirSync(path.join(root, ADR_DIR, 'drafts'));
    const errors = errorsOf(root);
    assertError(errors, /docs\/adr\/notes\.txt: unexpected entry/);
    assertError(errors, /docs\/adr\/12-short-number\.md: unexpected entry/);
    assertError(errors, /docs\/adr\/0012-Upper-Case\.md: unexpected entry/);
    assertError(errors, /docs\/adr\/drafts: unexpected entry/);
  });

  it('flags gaps and duplicate numbers', () => {
    const gap = makeRoot();
    write(gap, '0013-gap.md', adrText('0013', 'Gap'));
    addIndexRow(gap, `| [0013](0013-gap.md) | Gap | Accepted | §5 |`);
    assertError(errorsOf(gap), /0013-gap\.md: expected number 0012/);

    const dup = makeRoot();
    write(dup, '0011-another.md', adrText('0011', 'Another'));
    assertError(errorsOf(dup), /number 0011 is already used/);
  });

  it('flags an empty ADR directory, a missing index, template or Context Pack', () => {
    const empty = makeRoot();
    for (const file of INITIAL_ADRS) unlinkSync(path.join(empty, ADR_DIR, file));
    assertError(errorsOf(empty), /no ADRs found/);

    const noIndex = makeRoot();
    unlinkSync(path.join(noIndex, ADR_DIR, INDEX_FILE));
    unlinkSync(path.join(noIndex, ADR_DIR, TEMPLATE_FILE));
    const errors = errorsOf(noIndex);
    assertError(errors, /README\.md: missing \(the ADR index\)/);
    assertError(errors, /template\.md: missing/);

    const noPack = makeRoot();
    unlinkSync(path.join(noPack, CONTEXT_PACK));
    assertError(errorsOf(noPack), /CONTEXT_PACK\.md: missing/);

    const noDir = mkdtempSync(path.join(tmpdir(), 'bw-adr-'));
    tempRoots.push(noDir);
    assertError(errorsOf(noDir), /docs\/adr: missing/);
  });

  it('checks the title heading and the date line', () => {
    const root = makeRoot();
    replaceIn(root, TEMPORAL_ADR, '# ADR-0005:', '# ADR-0004:');
    assertError(errorsOf(root), /title says ADR-0004 but the file is number 0005/);

    replaceIn(root, TEMPORAL_ADR, '# ADR-0004: ', '# ');
    assertError(errorsOf(root), /title must be "# ADR-0005: <decision>"/);

    const period = makeRoot();
    replaceIn(period, TEMPORAL_ADR, '(hybrid orchestration)\n', '(hybrid orchestration).\n');
    assertError(errorsOf(period), /title must not end with a period/);

    const badDate = makeRoot();
    replaceIn(badDate, TEMPORAL_ADR, 'Date: 2026-10-20', 'Date: 2026-02-30');
    assertError(errorsOf(badDate), /"Date: 2026-02-30" is not a valid calendar date/);

    const noDate = makeRoot();
    replaceIn(noDate, TEMPORAL_ADR, 'Date: 2026-10-20\n\n', '');
    assertError(errorsOf(noDate), /needs a "Date: YYYY-MM-DD" line/);
  });

  it('requires every section, non-empty and in order', () => {
    const missing = makeRoot();
    replaceIn(missing, TEMPORAL_ADR, '## Consequences\n', '## Outcomes\n');
    assertError(errorsOf(missing), /missing section "## Consequences"/);

    const order = makeRoot();
    const text = read(order, TEMPORAL_ADR);
    const status = text.indexOf('## Status');
    const context = text.indexOf('## Context');
    const decision = text.indexOf('## Decision');
    write(
      order,
      TEMPORAL_ADR,
      text.slice(0, status) +
        text.slice(context, decision) +
        text.slice(status, context) +
        text.slice(decision),
    );
    assertError(
      errorsOf(order),
      /section "## Context" is out of order|section "## Status" is out of order/,
    );

    const empty = makeRoot();
    replaceIn(empty, TEMPORAL_ADR, '## Status\n\nAccepted\n', '## Status\n\n<!-- tbd -->\n');
    assertError(errorsOf(empty), /section "## Status" is empty/);
  });

  it('accepts every documented status and rejects anything else', () => {
    for (const status of STATUS_VALUES) {
      const root = makeRoot();
      replaceIn(root, TEMPORAL_ADR, '## Status\n\nAccepted\n', `## Status\n\n${status}\n`);
      replaceIn(
        root,
        INDEX_FILE,
        '| Drive the run lifecycle with Temporal workflows (hybrid orchestration) | Accepted |',
        `| Drive the run lifecycle with Temporal workflows (hybrid orchestration) | ${status} |`,
      );
      assert.deepEqual(errorsOf(root), [], status);
    }
    const root = makeRoot();
    replaceIn(root, TEMPORAL_ADR, '## Status\n\nAccepted\n', '## Status\n\nApproved\n');
    assertError(errorsOf(root), /unknown status "Approved"/);

    replaceIn(
      root,
      TEMPORAL_ADR,
      '## Status\n\nApproved\n',
      '## Status\n\nAccepted\nby the team\n',
    );
    assertError(errorsOf(root), /unexpected Status line "by the team"/);
  });

  it('keeps ADRs short (restate decisions, not implementation detail)', () => {
    const root = makeRoot();
    const filler = Array.from({ length: MAX_ADR_LINES }, (_, i) => `- detail ${i}`).join('\n');
    replaceIn(root, TEMPORAL_ADR, '## References\n', `## References\n\n${filler}\n`);
    assertError(errorsOf(root), new RegExp(`lines exceeds ${MAX_ADR_LINES}`));
  });

  it('requires a Context Pack heading citation in References', () => {
    const root = makeRoot();
    const text = read(root, TEMPORAL_ADR);
    const at = text.indexOf('## References');
    write(root, TEMPORAL_ADR, `${text.slice(0, at)}## References\n\n- Nothing cited.\n`);
    assertError(
      errorsOf(root),
      /"## References" must cite a docs\/architecture\/CONTEXT_PACK\.md heading/,
    );

    const fileOnly = makeRoot();
    write(
      fileOnly,
      TEMPORAL_ADR,
      `${text.slice(0, at)}## References\n\n- [Context Pack](${PACK_LINK}).\n`,
    );
    assertError(errorsOf(fileOnly), /must cite a docs\/architecture\/CONTEXT_PACK\.md heading/);
  });

  it('fails when a cited Context Pack heading does not exist', () => {
    const root = makeRoot();
    replaceIn(
      root,
      TEMPORAL_ADR,
      '#42-hybrid-orchestration-why-and-how',
      '#42-hybrid-orchestration',
    );
    assertError(
      errorsOf(root),
      /"\.\.\/architecture\/CONTEXT_PACK\.md#42-hybrid-orchestration" matches no heading/,
    );
  });

  it('fails when the Context Pack renames a cited heading (drift)', () => {
    const root = makeRoot();
    writeFileSync(
      path.join(root, CONTEXT_PACK),
      REAL_PACK.replace('### 4.2 Hybrid orchestration (why and how)', '### 4.2 Orchestration'),
    );
    assertError(
      errorsOf(root),
      /0005-temporal-run-lifecycle\.md: link .*#42-hybrid-orchestration-why-and-how" matches no heading/,
    );
  });

  it('fails on a § reference that the Context Pack does not have', () => {
    const root = makeRoot();
    replaceIn(root, TEMPORAL_ADR, '§8.5 (kill switch)', '§8.12 (kill switch) and §99');
    const errors = errorsOf(root);
    assertError(errors, /references §8\.12, which does not exist/);
    assertError(errors, /references §99, which does not exist/);
  });

  it('checks relative links', () => {
    const root = makeRoot();
    replaceIn(
      root,
      TEMPORAL_ADR,
      'Temporal becomes',
      '[gone](0099-missing.md), [abs](/etc/hosts), [up](../../../outside.md) and [self](#nope) Temporal becomes',
    );
    const errors = errorsOf(root);
    assertError(errors, /broken link "0099-missing\.md"/);
    assertError(errors, /"\/etc\/hosts" must be relative/);
    assertError(errors, /"\.\.\/\.\.\/\.\.\/outside\.md" points outside the repository/);
    assertError(errors, /"#nope" matches no heading in docs\/adr\/0005-temporal-run-lifecycle\.md/);
  });

  it('does not fetch external links', () => {
    const root = makeRoot();
    replaceIn(root, TEMPORAL_ADR, 'Temporal becomes', '[t](https://temporal.io/) Temporal becomes');
    assert.deepEqual(errorsOf(root), []);
  });
});

describe('check-adr: supersession (ADRs are immutable)', () => {
  const NEW_FILE = '0012-replace-the-run-controller.md';
  const NEW_TITLE = 'Replace the run controller';

  /**
   * @param {{ oldStatus?: string, newStatus?: string }} [options]
   * @returns {string}
   */
  function supersede(options = {}) {
    const root = makeRoot();
    const oldStatus = options.oldStatus ?? `Superseded by [ADR-0012](${NEW_FILE})`;
    const newStatus = options.newStatus ?? `Accepted\nSupersedes [ADR-0005](${TEMPORAL_ADR})`;
    write(root, NEW_FILE, adrText('0012', NEW_TITLE, newStatus));
    replaceIn(root, TEMPORAL_ADR, '## Status\n\nAccepted\n', `## Status\n\n${oldStatus}\n`);
    replaceIn(
      root,
      INDEX_FILE,
      '| Drive the run lifecycle with Temporal workflows (hybrid orchestration) | Accepted |',
      `| Drive the run lifecycle with Temporal workflows (hybrid orchestration) | ${oldStatus} |`,
    );
    addIndexRow(root, `| [0012](${NEW_FILE}) | ${NEW_TITLE} | Accepted | §5 |`);
    return root;
  }

  it('accepts a two-sided supersession', () => {
    const root = supersede();
    assert.deepEqual(errorsOf(root), []);
    const adr = checkAdrs(root).adrs.find((a) => a.number === '0005');
    assert.equal(adr?.status, 'Superseded by ADR-0012');
  });

  it('fails when the new ADR does not say what it supersedes', () => {
    assertError(
      errorsOf(supersede({ newStatus: 'Accepted' })),
      /0012-replace-the-run-controller\.md does not say "Supersedes \[ADR-0005\]/,
    );
  });

  it('fails when the old ADR is not marked superseded', () => {
    assertError(
      errorsOf(supersede({ oldStatus: 'Accepted' })),
      /supersedes ADR-0005, but 0005-temporal-run-lifecycle\.md is not "Superseded by \[ADR-0012\]/,
    );
  });

  it('fails when an ADR is superseded by an older, missing or mislinked ADR', () => {
    assertError(
      errorsOf(
        supersede({
          oldStatus: 'Superseded by [ADR-0004](0004-nestjs-fastify-rest-graphql-api.md)',
          newStatus: 'Accepted',
        }),
      ),
      /a superseding ADR must be newer/,
    );
    assertError(
      errorsOf(
        supersede({ oldStatus: 'Superseded by [ADR-0042](0042-nope.md)', newStatus: 'Accepted' }),
      ),
      /superseded by ADR-0042, which does not exist/,
    );
    assertError(
      errorsOf(supersede({ oldStatus: `Superseded by [ADR-0012](${TEMPORAL_ADR})` })),
      /links to 0005-temporal-run-lifecycle\.md, not an ADR-0012 file/,
    );
    assertError(
      errorsOf(supersede({ newStatus: 'Accepted\nSupersedes [ADR-0077](0077-nope.md)' })),
      /supersedes ADR-0077, which does not exist/,
    );
  });
});

describe('check-adr: index', () => {
  it('fails when an ADR is missing from the index', () => {
    const root = makeRoot();
    write(root, '0012-new-decision.md', adrText('0012', 'New decision'));
    assertError(errorsOf(root), /index does not list ADR-0012/);
  });

  it('fails when the index lists an ADR that does not exist, twice, or out of order', () => {
    const root = makeRoot();
    addIndexRow(root, '| [0012](0012-ghost.md) | Ghost | Accepted | §5 |');
    assertError(errorsOf(root), /lists ADR-0012, which does not exist/);

    const twice = makeRoot();
    addIndexRow(
      twice,
      '| [0011](0011-gvisor-sandboxes-on-k3s.md) | Isolate agent sessions in gVisor sandboxes on k3s and never expose the host Docker socket | Accepted | §1.1, §4.1, §5, §8 |',
    );
    assertError(errorsOf(twice), /ADR-0011 is listed more than once/);

    const order = makeRoot();
    addIndexRow(order, '| [0003](0003-strict-typescript-zod-contracts.md) | x | Accepted | §5 |');
    assertError(errorsOf(order), /ADR-0003 is listed after ADR-0011/);

    const malformed = makeRoot();
    addIndexRow(malformed, '| ADR-12 | x | Accepted | §5 |');
    assertError(errorsOf(malformed), /must start with "\[NNNN\]\(NNNN-….md\)"/);
  });

  it('fails when the index disagrees with an ADR title, file, status or citations', () => {
    const root = makeRoot();
    replaceIn(
      root,
      INDEX_FILE,
      '| Drive the run lifecycle with Temporal workflows (hybrid orchestration) | Accepted | §3.3, §4.2, §5, §8 |',
      '| Drive runs with Temporal | Deprecated | §4.2 |',
    );
    replaceIn(
      root,
      INDEX_FILE,
      '[0004](0004-nestjs-fastify-rest-graphql-api.md)',
      '[0004](0003-strict-typescript-zod-contracts.md)',
    );
    const errors = errorsOf(root);
    assertError(errors, /ADR-0005 title "Drive runs with Temporal" does not match/);
    assertError(errors, /ADR-0005 status "Deprecated" does not match "Accepted"/);
    assertError(
      errors,
      /ADR-0005 Context Pack column "§4\.2" does not match its References \(§3\.3, §4\.2, §5, §8\)/,
    );
    assertError(errors, /ADR-0004 links to 0003-strict-typescript-zod-contracts\.md, not 0004/);
  });

  it('fails without an Index section', () => {
    const root = makeRoot();
    replaceIn(root, INDEX_FILE, '## Index\n', '## Decisions\n');
    assertError(errorsOf(root), /missing section "## Index"/);
  });

  it('checks the template for the required sections', () => {
    const root = makeRoot();
    replaceIn(root, TEMPLATE_FILE, '## References\n', '## Links\n');
    assertError(errorsOf(root), /template\.md: missing section "## References"/);
  });
});

describe('check-adr: CLI', () => {
  /**
   * @param {string[]} args
   */
  function run(args) {
    return spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8', env: cleanEnv() });
  }

  it('exits 0 with a JSON summary on the repository', () => {
    const result = run(['--root', REPO_ROOT]);
    assert.equal(result.status, 0, result.stderr);
    const summary = parseJsonObject(result.stdout);
    assert.equal(summary.ok, true);
  });

  it('exits 1 and lists the problems when a check fails', () => {
    const root = makeRoot();
    unlinkSync(path.join(root, ADR_DIR, INDEX_FILE));
    const result = run(['--root', root, '--quiet']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /README\.md: missing/);
  });

  it('exits 2 on bad arguments', () => {
    assert.equal(run(['--bogus']).status, 2);
    assert.equal(run(['--root']).status, 2);
  });
});
