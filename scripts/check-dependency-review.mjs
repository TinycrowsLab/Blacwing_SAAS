#!/usr/bin/env node
// Checks the dependency-review policy (CI-014, #148):
// - workflow runs on pull_request with the SHA-pinned dependency-review action and least privilege;
// - config fails on HIGH+ severity, denies the §5 license-review items, comments a PR summary.
//
// Usage: node scripts/check-dependency-review.mjs [--root <dir>]

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const WORKFLOW = '.github/workflows/dependency-review.yml';
export const CONFIG = '.github/dependency-review-config.yml';
export const REQUIRED_DENIED = ['LicenseRef-NPSL', 'AGPL-3.0-only', 'AGPL-3.0-or-later'];
const SEVERITIES = ['high', 'critical'];
// The action rejects the whole config if any deny entry is not valid SPDX. Entries must be a
// LicenseRef- custom id or one of these SPDX-listed ids (extend when adding a listed license).
export const SPDX_LISTED = [
  'AGPL-1.0-only',
  'AGPL-1.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'SSPL-1.0',
  'BUSL-1.1',
];
const LICENSE_REF = /^LicenseRef-[A-Za-z0-9.-]+$/;

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {string} text
 * @returns {string[]} problems
 */
export function checkConfig(text) {
  /** @type {string[]} */
  const errors = [];
  /** @type {unknown} */
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    return [`${CONFIG} is not valid YAML: ${message(error)}`];
  }
  if (!isRecord(doc)) return [`${CONFIG} must be a mapping`];
  const severity = doc['fail-on-severity'];
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
    errors.push(`${CONFIG}: fail-on-severity must be high or critical`);
  }
  const deny = doc['deny-licenses'];
  if (!Array.isArray(deny)) {
    errors.push(`${CONFIG}: deny-licenses must be an explicit list`);
  } else {
    for (const id of REQUIRED_DENIED) {
      if (!deny.includes(id)) errors.push(`${CONFIG}: deny-licenses must include ${id}`);
    }
    for (const id of deny) {
      if (typeof id !== 'string' || !(SPDX_LISTED.includes(id) || LICENSE_REF.test(id))) {
        errors.push(`${CONFIG}: deny-licenses entry ${String(id)} is not a valid SPDX id`);
      }
    }
  }
  if (doc['allow-licenses'] !== undefined) {
    errors.push(`${CONFIG}: allow-licenses conflicts with the explicit deny-list`);
  }
  if (doc['comment-summary-in-pr'] !== 'always') {
    errors.push(`${CONFIG}: comment-summary-in-pr must be 'always'`);
  }
  return errors;
}

/**
 * @param {string} text
 * @returns {string[]} problems
 */
export function checkWorkflow(text) {
  /** @type {string[]} */
  const errors = [];
  /** @type {unknown} */
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    return [`${WORKFLOW} is not valid YAML: ${message(error)}`];
  }
  if (!isRecord(doc)) return [`${WORKFLOW} must be a mapping`];
  const on = doc.on;
  if (!isRecord(on) || !('pull_request' in on)) {
    errors.push(`${WORKFLOW}: must trigger on pull_request`);
  }
  if (isRecord(on) && 'pull_request_target' in on) {
    errors.push(`${WORKFLOW}: must not use pull_request_target`);
  }
  const perms = doc.permissions;
  if (!isRecord(perms) || perms.contents !== 'read' || Object.keys(perms).length !== 1) {
    errors.push(`${WORKFLOW}: top-level permissions must be exactly contents: read`);
  }
  if (!/uses:\s*actions\/dependency-review-action@[0-9a-f]{40}\s+#\s*v\d/.test(text)) {
    errors.push(`${WORKFLOW}: must use actions/dependency-review-action pinned to a SHA`);
  }
  if (!text.includes('config-file: ./.github/dependency-review-config.yml')) {
    errors.push(`${WORKFLOW}: must load ${CONFIG}`);
  }
  if (!/pull-requests:\s*write/.test(text)) {
    errors.push(`${WORKFLOW}: job needs pull-requests: write for the comment summary`);
  }
  return errors;
}

/**
 * @param {string} root
 * @returns {string[]} problems
 */
export function checkRepo(root) {
  /** @type {string[]} */
  const errors = [];
  /** @type {[string, (text: string) => string[]][]} */
  const targets = [
    [WORKFLOW, checkWorkflow],
    [CONFIG, checkConfig],
  ];
  for (const [file, check] of targets) {
    const full = path.join(root, file);
    if (!existsSync(full)) errors.push(`${file} is missing`);
    else errors.push(...check(readFileSync(full, 'utf8')));
  }
  return errors;
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
      `check-dependency-review: ${errors.length} problem(s) found:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`,
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
