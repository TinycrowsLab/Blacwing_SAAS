// Tests for the Renovate policy checker (FOUND-017) and the real renovate.json.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { REQUIRED_GROUPS, checkRenovate, checkRepo, main } from './check-renovate.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

/** @returns {Config} */
const real = () => {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(path.join(REPO_ROOT, 'renovate.json'), 'utf8'));
  return /** @type {Config} */ (parsed);
};
/** @type {Config} */ (
  /** @type {unknown} */ (JSON.parse(readFileSync(path.join(REPO_ROOT, 'renovate.json'), 'utf8')))
);
/**
 * @typedef {{ groupName?: string, pinDigests?: boolean, automerge?: boolean,
 *   matchUpdateTypes?: string[], matchManagers?: string[] }} Rule
 */
/**
 * @typedef {{ rangeStrategy?: string, pinDigests?: boolean, dependencyDashboard?: boolean,
 *   automerge?: boolean, packageRules: Rule[], semanticCommits?: string,
 *   semanticCommitType?: string, semanticCommitScope?: string, schedule: string[],
 *   osvVulnerabilityAlerts?: boolean, prConcurrentLimit: number, prHourlyLimit: number,
 *   lockFileMaintenance?: object,
 *   vulnerabilityAlerts: { enabled?: boolean, labels: string[], schedule?: string[] } }} Config
 */
/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
const clone = (value) => structuredClone(value);

describe('renovate.json', () => {
  it('meets the policy', () => {
    assert.deepEqual(checkRepo(REPO_ROOT), []);
    assert.equal(main(['--root', REPO_ROOT]), 0);
  });

  it('pins exact versions and digests, groups every ecosystem and enables the dashboard', () => {
    const config = real();
    assert.equal(config.rangeStrategy, 'pin');
    assert.equal(config.pinDigests, true);
    assert.equal(config.dependencyDashboard, true);
    const groups = config.packageRules.map((/** @type {Rule} */ r) => r.groupName);
    for (const group of REQUIRED_GROUPS) assert.ok(groups.includes(group), group);
  });

  it('uses Conventional Commit messages and a weekly off-peak schedule', () => {
    const config = real();
    assert.equal(config.semanticCommits, 'enabled');
    assert.equal(config.semanticCommitType, 'chore');
    assert.equal(config.semanticCommitScope, 'deps');
    assert.match(String(config.schedule[0]), /before 6am on monday/);
  });

  it('prioritises vulnerability alerts with a security label', () => {
    const config = real();
    assert.ok(config.vulnerabilityAlerts.labels.includes('security'));
    assert.equal(config.osvVulnerabilityAlerts, true);
    assert.deepEqual(config.vulnerabilityAlerts.schedule, ['at any time']);
  });

  it('caps open PRs (noisy PR edge case)', () => {
    const config = real();
    assert.ok(config.prConcurrentLimit <= 5);
    assert.ok(config.prHourlyLimit <= 2);
  });
});

describe('checkRenovate', () => {
  it('rejects non-objects and missing files', () => {
    assert.deepEqual(checkRenovate([]), ['renovate.json must be a JSON object']);
    assert.match(String(checkRepo(path.join(REPO_ROOT, 'docs'))[0]), /missing/);
  });

  it('fails when a required group is removed', () => {
    const config = clone(real());
    config.packageRules = config.packageRules.filter(
      (/** @type {Rule} */ r) => r.groupName !== 'nestjs',
    );
    assert.ok(checkRenovate(config).includes('missing group "nestjs"'));
  });

  it('fails when pinning is weakened', () => {
    const config = clone(real());
    config.rangeStrategy = 'bump';
    config.pinDigests = false;
    config.packageRules = config.packageRules.filter(
      (/** @type {Rule} */ r) => r.pinDigests !== true,
    );
    const errors = checkRenovate(config);
    assert.ok(errors.some((e) => e.includes('rangeStrategy')));
    assert.ok(errors.some((e) => e.includes('pinDigests must be true')));
    assert.ok(errors.some((e) => e.includes('docker datasource')));
    assert.ok(errors.some((e) => e.includes('github-actions')));
  });

  it('fails when automerge is broadened beyond patch (breaking-patch edge case)', () => {
    const minor = clone(real());
    minor.packageRules.push({ matchUpdateTypes: ['minor', 'patch'], automerge: true });
    assert.ok(checkRenovate(minor).some((e) => e.includes('only allowed for matchUpdateTypes')));

    const global = clone(real());
    global.automerge = true;
    assert.ok(checkRenovate(global).some((e) => e.includes('global automerge')));
  });

  it('fails when majors or Actions digests can automerge', () => {
    const config = clone(real());
    config.packageRules.push(
      { matchUpdateTypes: ['major'], automerge: true },
      { matchManagers: ['github-actions'], matchUpdateTypes: ['digest'], automerge: true },
    );
    const errors = checkRenovate(config);
    assert.ok(errors.some((e) => e.includes('major updates must never automerge')));
    assert.ok(errors.some((e) => e.includes('Actions digest')));
  });

  it('fails without lockfile maintenance, alerts, limits or conventional commits', () => {
    const config = clone(real());
    delete config.lockFileMaintenance;
    config.vulnerabilityAlerts = { enabled: true, labels: [] };
    config.osvVulnerabilityAlerts = false;
    config.prConcurrentLimit = 0;
    config.schedule = ['at any time'];
    config.semanticCommits = 'disabled';
    config.semanticCommitScope = 'x';
    const errors = checkRenovate(config);
    for (const needle of [
      'lockFileMaintenance',
      'labelled "security"',
      'osvVulnerabilityAlerts',
      'prConcurrentLimit',
      'weekly',
      'Conventional Commits',
      'semanticCommitScope',
    ]) {
      assert.ok(
        errors.some((e) => e.includes(needle)),
        needle,
      );
    }
  });
});
