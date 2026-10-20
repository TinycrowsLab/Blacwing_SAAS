// Tests for the CodeQL policy checker (CI-013, #147) against the real files.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CONFIG, WORKFLOW, checkConfig, checkRepo, checkWorkflow, main } from './check-codeql.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const config = readFileSync(path.join(REPO_ROOT, CONFIG), 'utf8');
const workflow = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8');

describe('codeql policy', () => {
  it('accepts the real repo files', () => {
    assert.deepEqual(checkRepo(REPO_ROOT), []);
    assert.equal(main(['--root', REPO_ROOT]), 0);
  });

  it('fails when a language is dropped from the matrix', () => {
    const noGo = workflow.replace('language: go', 'language: python');
    assert.ok(checkWorkflow(noGo).some((e) => e.includes('go')));
    const noJs = workflow.replace('language: javascript-typescript', 'language: python');
    assert.ok(checkWorkflow(noJs).some((e) => e.includes('javascript-typescript')));
  });

  it('fails when the Go build skips the Makefile', () => {
    assert.ok(checkWorkflow(workflow.replace('make build', 'go build ./...')).length > 0);
  });

  it('fails when the weekly schedule or main push trigger is removed', () => {
    const noSchedule = workflow.replace(/ {2}schedule:\n.*\n/, '');
    assert.ok(checkWorkflow(noSchedule).some((e) => e.includes('schedule')));
    const noPush = workflow.replace('branches: [main]', 'branches: [dev]');
    assert.ok(checkWorkflow(noPush).some((e) => e.includes('push')));
  });

  it('fails on unsafe triggers, widened permissions and unpinned actions', () => {
    const target = workflow.replace('  pull_request:', '  pull_request_target:');
    assert.ok(checkWorkflow(target).length > 0);
    const widened = workflow.replace(
      'permissions:\n  contents: read\n',
      'permissions:\n  contents: write\n',
    );
    assert.ok(checkWorkflow(widened).some((e) => e.includes('permissions')));
    const unpinned = workflow.replace(
      /codeql-action\/analyze@[0-9a-f]{40}/,
      'codeql-action/analyze@v4',
    );
    assert.ok(checkWorkflow(unpinned).some((e) => e.includes('pinned')));
    const noSarif = workflow.replace('security-events: write', 'security-events: read');
    assert.ok(checkWorkflow(noSarif).some((e) => e.includes('security-events')));
  });

  it('fails when the query suite is weakened or paths are widened', () => {
    const weak = checkConfig(config.replace('uses: security-and-quality', 'uses: default'));
    assert.ok(weak.some((e) => e.includes('queries')));
    const wide = checkConfig(config.replace('  - apps\n', ''));
    assert.ok(wide.some((e) => e.includes('paths')));
  });

  it('reports missing files and a non-zero exit', () => {
    const dir = path.join(REPO_ROOT, 'scripts');
    assert.equal(checkRepo(dir).length, 2);
    assert.equal(main(['--root', dir]), 1);
  });
});
