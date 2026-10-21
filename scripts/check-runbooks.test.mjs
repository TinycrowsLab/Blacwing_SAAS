import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkRunbooks,
  isValidValidationStamp,
  OPERATOR_RUNBOOKS,
  parseArgs,
} from './check-runbooks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PACK = `# Pack

## 8. Security invariants

1. Kill switch.

## 9. API conventions
`;

/**
 * A runbook that passes every check; tests break one thing at a time.
 * @param {{ stamp?: string, body?: string }} [overrides]
 * @returns {string}
 */
function validRunbook(overrides = {}) {
  const stamp = overrides.stamp ?? 'never';
  const body =
    overrides.body ??
    `# Runbook

Read [the pack](../architecture/CONTEXT_PACK.md#8-security-invariants) and §8.5.
Run \`pnpm db:migrate\` and watch \`bw_kill_events_total\`.

## Validation

Run the drill.
`;
  return `---\nlast_validated: ${stamp}\n---\n\n${body}`;
}

describe('isValidValidationStamp', () => {
  it('accepts never and real calendar dates', () => {
    assert.equal(isValidValidationStamp('never'), true);
    assert.equal(isValidValidationStamp('2026-10-21'), true);
    assert.equal(isValidValidationStamp('2024-02-29'), true);
  });

  it('rejects dates that do not exist and malformed values', () => {
    assert.equal(isValidValidationStamp('2026-02-30'), false);
    assert.equal(isValidValidationStamp('2025-02-29'), false);
    assert.equal(isValidValidationStamp('21-10-2026'), false);
    assert.equal(isValidValidationStamp('yesterday'), false);
    assert.equal(isValidValidationStamp(''), false);
  });
});

describe('checkRunbooks', () => {
  /** @type {string[]} */
  const dirs = [];

  /**
   * Writes a fixture repository with all four runbooks valid, then applies `mutate` to it.
   * @param {(root: string) => void} [mutate]
   * @returns {string} the fixture root
   */
  function fixture(mutate) {
    const root = mkdtempSync(path.join(tmpdir(), 'check-runbooks-'));
    dirs.push(root);
    mkdirSync(path.join(root, 'docs/architecture'), { recursive: true });
    mkdirSync(path.join(root, 'docs/runbooks'), { recursive: true });
    mkdirSync(path.join(root, 'apps/worker/src'), { recursive: true });
    mkdirSync(path.join(root, 'packages/x/src'), { recursive: true });
    writeFileSync(path.join(root, 'docs/architecture/CONTEXT_PACK.md'), PACK);
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { 'db:migrate': 'x' } }),
    );
    writeFileSync(
      path.join(root, 'apps/worker/src/kill.ts'),
      "export const m = 'bw_kill_events_total';\n",
    );
    for (const name of OPERATOR_RUNBOOKS) {
      writeFileSync(path.join(root, 'docs/runbooks', name), validRunbook());
    }
    mutate?.(root);
    return root;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * @param {string} root
   * @param {string} name
   * @param {string} text
   */
  function rewrite(root, name, text) {
    writeFileSync(path.join(root, 'docs/runbooks', name), text);
  }

  it('passes the real repository runbooks', () => {
    const result = checkRunbooks(repoRoot);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.deepEqual(result.checked, [...OPERATOR_RUNBOOKS]);
  });

  it('passes a fully valid fixture', () => {
    const result = checkRunbooks(fixture());
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it('accepts a real validation date in front matter', () => {
    const root = fixture();
    rewrite(root, 'kill-switch.md', validRunbook({ stamp: '2026-10-21' }));
    assert.equal(checkRunbooks(root).ok, true);
  });

  it('fails when a required runbook is missing', () => {
    const root = fixture();
    rmSync(path.join(root, 'docs/runbooks/kill-switch.md'));
    const result = checkRunbooks(root);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes('docs/runbooks/kill-switch.md: missing runbook'));
  });

  it('fails when last_validated is absent', () => {
    const root = fixture();
    rewrite(root, 'kill-switch.md', validRunbook().replace(/^last_validated: never\n/m, ''));
    assert.ok(checkRunbooks(root).errors.some((e) => e.includes('last_validated')));
  });

  it('fails when last_validated is not a real date', () => {
    const root = fixture();
    rewrite(root, 'kill-switch.md', validRunbook({ stamp: '2026-02-30' }));
    assert.ok(
      checkRunbooks(root).errors.includes(
        'docs/runbooks/kill-switch.md: last_validated 2026-02-30 is not a real date',
      ),
    );
  });

  it('fails when the validation section is missing', () => {
    const root = fixture();
    rewrite(root, 'kill-switch.md', validRunbook({ body: '# Runbook\n\nNo procedure.\n' }));
    assert.ok(
      checkRunbooks(root).errors.includes(
        'docs/runbooks/kill-switch.md: missing a "## Validation" section',
      ),
    );
  });

  it('fails on a relative link to a file that does not exist', () => {
    const root = fixture();
    rewrite(
      root,
      'kill-switch.md',
      validRunbook({ body: '# R\n\nSee [gone](./nope.md).\n\n## Validation\n\nx\n' }),
    );
    assert.ok(checkRunbooks(root).errors.some((e) => e.includes('./nope.md')));
  });

  it('fails on an anchor that matches no heading in the target', () => {
    const root = fixture();
    rewrite(
      root,
      'kill-switch.md',
      validRunbook({
        body: '# R\n\nSee [pack](../architecture/CONTEXT_PACK.md#no-such-heading).\n\n## Validation\n\nx\n',
      }),
    );
    assert.ok(checkRunbooks(root).errors.some((e) => e.includes('no-such-heading')));
  });

  it('fails on a same-file anchor that matches no heading', () => {
    const root = fixture();
    rewrite(
      root,
      'kill-switch.md',
      validRunbook({ body: '# R\n\nSee [below](#missing).\n\n## Validation\n\nx\n' }),
    );
    assert.ok(checkRunbooks(root).errors.some((e) => e.includes('#missing')));
  });

  it('ignores external links', () => {
    const root = fixture();
    rewrite(
      root,
      'kill-switch.md',
      validRunbook({ body: '# R\n\nSee [site](https://example.com/x#y).\n\n## Validation\n\nx\n' }),
    );
    assert.equal(checkRunbooks(root).ok, true);
  });

  it('fails on a pnpm script that package.json does not define', () => {
    const root = fixture();
    rewrite(
      root,
      'kill-switch.md',
      validRunbook({ body: '# R\n\nRun `pnpm check:tofu` first.\n\n## Validation\n\nx\n' }),
    );
    assert.ok(
      checkRunbooks(root).errors.includes(
        'docs/runbooks/kill-switch.md: pnpm check:tofu is not a package.json script',
      ),
    );
  });

  it('fails on a metric that no source file defines', () => {
    const root = fixture();
    rewrite(
      root,
      'kill-switch.md',
      validRunbook({ body: '# R\n\nWatch `bw_runs_started_total`.\n\n## Validation\n\nx\n' }),
    );
    assert.ok(checkRunbooks(root).errors.some((e) => e.includes('bw_runs_started_total')));
  });

  it('does not count a metric that only appears in a test file', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'apps/worker/src/kill.test.ts'),
      "const m = 'bw_only_in_tests_total';\n",
    );
    rewrite(
      root,
      'kill-switch.md',
      validRunbook({ body: '# R\n\nWatch `bw_only_in_tests_total`.\n\n## Validation\n\nx\n' }),
    );
    assert.ok(checkRunbooks(root).errors.some((e) => e.includes('bw_only_in_tests_total')));
  });

  it('counts a metric defined in a package source file', () => {
    const root = fixture();
    writeFileSync(path.join(root, 'packages/x/src/m.ts'), "const m = 'bw_pkg_thing_total';\n");
    rewrite(
      root,
      'kill-switch.md',
      validRunbook({ body: '# R\n\nWatch `bw_pkg_thing_total`.\n\n## Validation\n\nx\n' }),
    );
    assert.equal(checkRunbooks(root).ok, true);
  });

  it('fails on a § reference to a section the Context Pack does not have', () => {
    const root = fixture();
    rewrite(
      root,
      'kill-switch.md',
      validRunbook({ body: '# R\n\nSee §99.5.\n\n## Validation\n\nx\n' }),
    );
    assert.ok(
      checkRunbooks(root).errors.includes(
        'docs/runbooks/kill-switch.md: §99 is not a Context Pack section',
      ),
    );
  });

  it('checks the top-level section of a dotted § reference', () => {
    const root = fixture();
    rewrite(
      root,
      'kill-switch.md',
      validRunbook({ body: '# R\n\nSee §8.5 and §9.\n\n## Validation\n\nx\n' }),
    );
    assert.equal(checkRunbooks(root).ok, true);
  });

  it('reports a missing Context Pack', () => {
    const root = fixture();
    rmSync(path.join(root, 'docs/architecture/CONTEXT_PACK.md'));
    assert.ok(
      checkRunbooks(root).errors.includes(
        'docs/architecture/CONTEXT_PACK.md: missing Context Pack',
      ),
    );
  });
});

describe('parseArgs', () => {
  it('defaults to the repository root and parses --root and --quiet', () => {
    assert.equal(parseArgs([]).quiet, false);
    assert.equal(parseArgs(['--quiet']).quiet, true);
    assert.equal(parseArgs(['--root', '/tmp/x']).root, path.resolve('/tmp/x'));
  });

  it('rejects an unknown argument and a --root without a value', () => {
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
    assert.throws(() => parseArgs(['--root']), /needs a directory/);
  });
});
