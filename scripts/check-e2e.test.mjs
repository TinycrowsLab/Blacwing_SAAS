// Tests for the e2e workflow policy (CI-006, #140) and its step summary, against the real files.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { COMPOSE, WORKFLOW, checkCompose, checkRepo, checkWorkflow, main } from './check-e2e.mjs';
import { main as summaryMain, renderSummary } from './e2e-summary.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const workflow = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8');
const compose = readFileSync(path.join(REPO_ROOT, COMPOSE), 'utf8');
const has = (/** @type {string[]} */ errors, /** @type {string} */ word) =>
  errors.some((e) => e.includes(word));

describe('e2e workflow policy', () => {
  it('accepts the real repo files', () => {
    assert.deepEqual(checkRepo(REPO_ROOT), []);
    assert.equal(main(['--root', REPO_ROOT]), 0);
  });

  it('requires the run-e2e label gate on pull requests, and nothing else gated', () => {
    const ungated = workflow.replace(
      " || contains(github.event.pull_request.labels.*.name, 'run-e2e')",
      '',
    );
    assert.ok(has(checkWorkflow(ungated), 'run-e2e'));
    const noLabeledEvent = workflow.replace(
      'types: [opened, synchronize, reopened, labeled]',
      'types: [opened]',
    );
    assert.ok(has(checkWorkflow(noLabeledEvent), 'labeled'));
  });

  it('always runs nightly and on main', () => {
    assert.ok(has(checkWorkflow(workflow.replace(/ {2}schedule:\n.*\n/, '')), 'schedule'));
    assert.ok(
      has(checkWorkflow(workflow.replace('branches: [main]', 'branches: [release]')), 'main'),
    );
  });

  it('keeps read-only permissions, no secrets, a hard timeout and a UTC clock', () => {
    assert.ok(
      has(checkWorkflow(workflow.replace('contents: read', 'contents: write')), 'permissions'),
    );
    assert.ok(has(checkWorkflow(`${workflow}\n# \${{ secrets.TOKEN }}\n`), 'secrets'));
    assert.ok(
      has(
        checkWorkflow(workflow.replace('timeout-minutes: 45', 'timeout-minutes: 600')),
        'timeout',
      ),
    );
    assert.ok(has(checkWorkflow(workflow.replace('TZ: UTC', 'TZ: Europe/Berlin')), 'TZ=UTC'));
  });

  it('reuses the DEVENV scripts in order: health-wait before seeding, seeding twice', () => {
    const seedFirst = workflow.replace(
      'node scripts/wait-for-health.mjs',
      'pnpm db:seed && node scripts/wait-for-health.mjs',
    );
    assert.ok(
      has(checkWorkflow(seedFirst.replace(/ {6}- name: Re-seed[^\n]*\n[^\n]*\n/, '')), 'order'),
    );
    const noHealth = workflow.replace('node scripts/wait-for-health.mjs', 'true');
    assert.ok(has(checkWorkflow(noHealth), 'wait-for-health'));
    const singleSeed = workflow.replace(/ {6}- name: Re-seed[^\n]*\n[^\n]*\n/, '');
    assert.ok(has(checkWorkflow(singleSeed), 'order'));
  });

  it('never boots the obs profile', () => {
    assert.ok(
      has(
        checkWorkflow(workflow.replace('run: pnpm dev:deps\n', 'run: pnpm dev:deps:obs\n')),
        'obs',
      ),
    );
  });

  it('uploads the report and traces on failure', () => {
    assert.ok(
      has(
        checkWorkflow(workflow.replace('if: ${{ failure() }}', 'if: ${{ success() }}')),
        'uploaded',
      ),
    );
    assert.ok(has(checkWorkflow(workflow.replace('apps/web/test-results\n', '')), 'uploaded'));
  });

  it('binds e2e services to loopback and pins their images by digest', () => {
    assert.ok(
      has(
        checkCompose(
          compose.replace(
            "'127.0.0.1:${BW_TARGET_JUICE_SHOP_PORT",
            "'0.0.0.0:${BW_TARGET_JUICE_SHOP_PORT",
          ),
        ),
        'off loopback',
      ),
    );
    assert.ok(
      has(
        checkCompose(compose.replace(/(bkimminich\/juice-shop:v[\d.]+)@sha256:[0-9a-f]{64}/, '$1')),
        'digest',
      ),
    );
  });
});

describe('e2e step summary', () => {
  it('reports counts and names failed and flaky tests', () => {
    const md = renderSummary(
      {
        stats: { expected: 3, unexpected: 1, flaky: 1, skipped: 0 },
        suites: [
          {
            title: 'a.e2e.ts',
            specs: [
              { title: 'ok', tests: [{ projectName: 'flows', status: 'expected' }] },
              { title: 'boom', tests: [{ projectName: 'flows', status: 'unexpected' }] },
            ],
            suites: [
              {
                title: 'nav',
                specs: [{ title: 'slow', tests: [{ projectName: 'navigation', status: 'flaky' }] }],
              },
            ],
          },
        ],
      },
      'failure',
    );
    assert.match(md, /^### e2e: failure/);
    assert.match(md, /\| 3 \| 1 \| 1 \| 0 \|/);
    assert.match(md, /- failed: \[flows\] a\.e2e\.ts › boom/);
    assert.match(md, /- flaky: \[navigation\] a\.e2e\.ts › nav › slow/);
    assert.doesNotMatch(md, /› ok/);
  });

  it('says when the suite never ran (setup or health-wait failed)', () => {
    const md = summaryMain([path.join(REPO_ROOT, 'does-not-exist.json')], { OUTCOME: 'failure' });
    assert.match(md, /Playwright did not run/);
    assert.match(md, /health-wait/);
  });
});
