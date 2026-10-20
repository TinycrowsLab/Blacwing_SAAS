#!/usr/bin/env node
// Checks the Renovate policy in renovate.json (FOUND-017) beyond what renovate-config-validator
// verifies (that the schema is valid): exact pins and digests, the mandatory groups, the narrow
// automerge rule, vulnerability alerts, rate limits, a weekly schedule and Conventional Commit
// messages. CI runs this next to `renovate-config-validator --strict`.
//
// Usage: node scripts/check-renovate.mjs [--root <dir>]
// Exits non-zero (listing every problem) when the policy is not met.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'renovate.json';
export const REQUIRED_GROUPS = Object.freeze([
  'typescript',
  'eslint',
  'nestjs',
  'next',
  'go',
  'docker',
  'github-actions',
  'testing',
]);
const MAX_OPEN_PRS = 10;
const NEVER_AUTOMERGE = Object.freeze(['major']);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} config parsed renovate.json
 * @returns {string[]} problems, empty when the policy is met
 */
export function checkRenovate(config) {
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(config)) return ['renovate.json must be a JSON object'];
  const rules = Array.isArray(config.packageRules)
    ? config.packageRules.filter((rule) => isRecord(rule))
    : [];

  if (config.rangeStrategy !== 'pin') errors.push('rangeStrategy must be "pin"');
  if (config.pinDigests !== true) errors.push('pinDigests must be true');
  if (!rules.some((r) => r.pinDigests === true && asArray(r.matchDatasources).includes('docker'))) {
    errors.push('a packageRule must pin digests for the docker datasource');
  }
  if (
    !rules.some((r) => r.pinDigests === true && asArray(r.matchManagers).includes('github-actions'))
  ) {
    errors.push('a packageRule must pin digests for github-actions');
  }

  const groups = new Set(rules.map((r) => r.groupName).filter((g) => typeof g === 'string'));
  for (const group of REQUIRED_GROUPS) {
    if (!groups.has(group)) errors.push(`missing group "${group}"`);
  }

  if (config.automerge !== false) {
    errors.push('global automerge must be false (opt in per rule only)');
  }
  const lock = config.lockFileMaintenance;
  if (!isRecord(lock) || lock.enabled !== true || lock.automerge !== true) {
    errors.push('lockFileMaintenance must be enabled with automerge: true');
  }
  for (const rule of rules.filter((r) => r.automerge === true)) {
    const types = asArray(rule.matchUpdateTypes);
    if (types.length !== 1 || types[0] !== 'patch' || rule.groupName !== undefined) {
      errors.push(
        `automerge rule is only allowed for matchUpdateTypes ["patch"]: ${JSON.stringify(rule)}`,
      );
    }
  }
  if (!rules.some((r) => r.automerge === true && asArray(r.matchUpdateTypes)[0] === 'patch')) {
    errors.push('a packageRule must automerge patch updates');
  }
  /** @param {(rule: Record<string, unknown>) => boolean} predicate */
  const lastFor = (predicate) => [...rules].reverse().find((rule) => predicate(rule));
  for (const type of NEVER_AUTOMERGE) {
    const last = lastFor((r) => asArray(r.matchUpdateTypes).includes(type));
    if (last?.automerge !== false) errors.push(`${type} updates must never automerge`);
  }
  const actionsDigest = lastFor(
    (r) =>
      asArray(r.matchManagers).includes('github-actions') &&
      asArray(r.matchUpdateTypes).includes('digest'),
  );
  if (actionsDigest?.automerge !== false) {
    errors.push('GitHub Actions digest updates must never automerge');
  }

  const vuln = config.vulnerabilityAlerts;
  if (!isRecord(vuln) || vuln.enabled === false || !asArray(vuln.labels).includes('security')) {
    errors.push('vulnerabilityAlerts must be enabled and labelled "security"');
  }
  if (config.osvVulnerabilityAlerts !== true) errors.push('osvVulnerabilityAlerts must be true');
  if (config.dependencyDashboard !== true) errors.push('dependencyDashboard must be true');

  for (const key of ['prConcurrentLimit', 'prHourlyLimit']) {
    const value = config[key];
    if (typeof value !== 'number' || value < 1 || value > MAX_OPEN_PRS) {
      errors.push(`${key} must be a number between 1 and ${MAX_OPEN_PRS}`);
    }
  }
  const schedule = asArray(config.schedule);
  if (
    schedule.length === 0 ||
    !schedule.every((s) => /\b(on|every) (mon|tues?|wed|thu|fri|sat|sun)/i.test(String(s)))
  ) {
    errors.push('schedule must be weekly (e.g. "before 6am on monday")');
  }
  if (config.semanticCommits !== 'enabled' || config.semanticCommitType !== 'chore') {
    errors.push('commits must be Conventional Commits with type "chore"');
  }
  if (config.semanticCommitScope !== 'deps') errors.push('semanticCommitScope must be "deps"');
  return errors;
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function asArray(value) {
  return Array.isArray(value) ? /** @type {unknown[]} */ (value) : [];
}

/** @param {string} root */
export function checkRepo(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) return [`${CONFIG_FILE} is missing`];
  try {
    return checkRenovate(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    return [
      `${CONFIG_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/** @param {string[]} argv */
export function main(argv) {
  const rootFlag = argv.indexOf('--root');
  const root =
    rootFlag >= 0 && argv[rootFlag + 1] !== undefined
      ? path.resolve(argv[rootFlag + 1] ?? '')
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkRepo(root);
  if (errors.length > 0) {
    process.stderr.write(
      `check-renovate: ${errors.length} problem(s) found:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`,
    );
    return 1;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
