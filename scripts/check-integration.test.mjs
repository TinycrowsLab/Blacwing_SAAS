// Tests for the integration-job policy check (CI-004, #138).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { check, checkWorkflow, main, parseLock, TEST_WORKFLOW } from './check-integration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(path.join(root, TEST_WORKFLOW), 'utf8');

describe('check-integration', () => {
  it('passes on the repository', () => {
    assert.deepEqual(check(root), []);
    assert.equal(main(['--root', root]), 0);
  });

  it('parses the lock manifest, skipping comments', () => {
    assert.deepEqual(parseLock('# c\n\na=x@sha256:1\n'), { a: 'x@sha256:1' });
  });

  it('flags a missing job', () => {
    assert.match(
      checkWorkflow('jobs:\n  unit:\n    steps: []\n').join('\n'),
      /no "integration" job/,
    );
  });

  it('flags a job that enables reuse, drops read-only permissions or uses secrets', () => {
    const bad = workflow
      .replace("TESTCONTAINERS_REUSE_ENABLE: 'false'", "TESTCONTAINERS_REUSE_ENABLE: 'true'")
      .replace('permissions:\n  contents: read', 'permissions:\n  contents: write')
      .replace('TZ: UTC\n      # Every', 'TZ: ${{ secrets.X }}\n      # Every');
    const out = checkWorkflow(bad).join('\n');
    assert.match(out, /must not enable Testcontainers reuse/);
    assert.match(out, /contents: read/);
    assert.match(out, /must not use secrets/);
  });

  it('flags missing pull retry, JUnit and failure-only uploads', () => {
    const bad = workflow
      .replaceAll('attempt', 'try')
      .replaceAll('junit', 'xml')
      .replace(
        'if: ${{ failure() }}\n        uses: actions/upload-artifact',
        'if: ${{ success() }}\n        uses: actions/upload-artifact',
      );
    const out = checkWorkflow(bad).join('\n');
    assert.match(out, /must retry/);
    assert.match(out, /JUnit/);
    assert.match(out, /upload must run when tests fail/);
  });

  it('reports image drift against the lock', () => {
    const problems = check(path.join(root, 'scripts', 'fixtures'));
    assert.match(problems.join('\n'), /images\.lock is missing/);
  });
});
