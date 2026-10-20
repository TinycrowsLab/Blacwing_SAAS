// Tests for the dependency-review policy checker (CI-014, #148) against the real files.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CONFIG,
  WORKFLOW,
  checkConfig,
  checkRepo,
  checkWorkflow,
  main,
} from './check-dependency-review.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const config = readFileSync(path.join(REPO_ROOT, CONFIG), 'utf8');
const workflow = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8');

describe('dependency-review policy', () => {
  it('accepts the real repo files', () => {
    assert.deepEqual(checkRepo(REPO_ROOT), []);
    assert.equal(main(['--root', REPO_ROOT]), 0);
  });

  it('fails when severity is weakened', () => {
    const errors = checkConfig(
      config.replace('fail-on-severity: high', 'fail-on-severity: moderate'),
    );
    assert.ok(errors.some((e) => e.includes('fail-on-severity')));
  });

  it('fails when a denied license (NPSL) is removed', () => {
    const errors = checkConfig(config.replace('  - LicenseRef-NPSL\n', ''));
    assert.ok(errors.some((e) => e.includes('LicenseRef-NPSL')));
  });

  it('fails when an allow-list is added or the comment is disabled', () => {
    const withAllow = checkConfig(`${config}allow-licenses:\n  - MIT\n`);
    assert.ok(withAllow.some((e) => e.includes('allow-licenses')));
    const noComment = checkConfig(config.replace('always', 'never'));
    assert.ok(noComment.some((e) => e.includes('comment-summary')));
  });

  it('fails on unsafe triggers, permissions and an unpinned action', () => {
    assert.ok(checkWorkflow(workflow.replace('pull_request:', 'pull_request_target:')).length > 0);
    const widened = workflow.replace(
      'permissions:\n  contents: read\n',
      'permissions:\n  contents: write\n',
    );
    assert.ok(checkWorkflow(widened).some((e) => e.includes('permissions')));
    const unpinned = workflow.replace(
      /dependency-review-action@[0-9a-f]{40}/,
      'dependency-review-action@v5',
    );
    assert.ok(checkWorkflow(unpinned).some((e) => e.includes('pinned')));
  });

  it('reports missing files and a non-zero exit', () => {
    const dir = path.join(REPO_ROOT, 'scripts');
    assert.equal(checkRepo(dir).length, 2);
    assert.equal(main(['--root', dir]), 1);
  });
});
