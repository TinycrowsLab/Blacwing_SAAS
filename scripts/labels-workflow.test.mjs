import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parse } from 'yaml';

/**
 * @typedef {{ if?: string, permissions: Record<string, string>, concurrency?: { group: string },
 *   steps: { run?: string, uses?: string }[] }} Job
 */
/** @typedef {{ permissions: Record<string, string>, on: Record<string, unknown>, jobs: Record<string, Job> }} Wf */
/** @type {unknown} */
const doc = parse(
  readFileSync(new URL('../.github/workflows/labels.yml', import.meta.url), 'utf8'),
);
const wf = /** @type {Wf} */ (doc);
/** @param {Job} job */
const runs = (job) => job.steps.map((s) => s.run ?? '').join('\n');
/**
 * @param {string} name
 * @returns {Job}
 */
const jobOf = (name) => {
  const job = wf.jobs[name];
  if (!job) throw new Error(`labels.yml has no ${name} job`);
  return job;
};

test('defaults to read-only contents', () => {
  assert.deepEqual(wf.permissions, { contents: 'read' });
});

test('labels-check is read-only, checks docs and never writes labels', () => {
  const job = jobOf('labels-check');
  assert.equal(job.permissions.issues, 'read');
  assert.match(runs(job), /sync-labels\.mjs --check-docs/);
  assert.match(runs(job), /--dry-run --repo/);
  assert.doesNotMatch(runs(job), /--prune/);
  assert.ok(job.steps.some((s) => s.uses === './.github/actions/setup'));
});

test('labels-sync is gated by BW_ONLINE, serialised, and the only writer', () => {
  const job = jobOf('labels-sync');
  assert.match(job.if ?? '', /vars\.BW_ONLINE == 'true'/);
  assert.equal(job.concurrency?.group, 'labels-sync');
  assert.equal(job.permissions.issues, 'write');
  assert.doesNotMatch(runs(job), /--prune|--dry-run/);
  assert.notEqual(jobOf('labels-check').permissions.issues, 'write');
  assert.ok(wf.on.workflow_dispatch !== undefined);
});
