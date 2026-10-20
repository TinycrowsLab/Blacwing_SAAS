#!/usr/bin/env node
// Checks the CodeQL policy (CI-013, #147): both languages in the matrix, a Makefile-based Go
// build, PR + main push + weekly schedule triggers, SHA-pinned actions, least privilege and a
// security query suite.
//
// Usage: node scripts/check-codeql.mjs [--root <dir>]

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const WORKFLOW = '.github/workflows/codeql.yml';
export const CONFIG = '.github/codeql-config.yml';
const SUITES = ['security-extended', 'security-and-quality'];

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {string} text
 * @param {string} file
 * @returns {{ doc?: Record<string, unknown>, error?: string }}
 */
function load(text, file) {
  try {
    /** @type {unknown} */
    const doc = parse(text);
    return isRecord(doc) ? { doc } : { error: `${file} must be a mapping` };
  } catch (error) {
    return { error: `${file} is not valid YAML: ${message(error)}` };
  }
}

/**
 * @param {string} text
 * @returns {string[]} problems
 */
export function checkConfig(text) {
  const { doc, error } = load(text, CONFIG);
  if (!doc) return [error ?? `${CONFIG} is invalid`];
  /** @type {string[]} */
  const errors = [];
  const queries = Array.isArray(doc.queries) ? doc.queries : [];
  const suiteOk = queries.some((q) => isRecord(q) && SUITES.includes(String(q.uses)));
  if (!suiteOk) errors.push(`${CONFIG}: queries must use ${SUITES.join(' or ')}`);
  const paths = doc.paths;
  if (!Array.isArray(paths) || !paths.includes('apps') || !paths.includes('packages')) {
    errors.push(`${CONFIG}: paths must focus on apps and packages`);
  }
  return errors;
}

/**
 * @param {string} text
 * @returns {string[]} problems
 */
export function checkWorkflow(text) {
  const { doc, error } = load(text, WORKFLOW);
  if (!doc) return [error ?? `${WORKFLOW} is invalid`];
  /** @type {string[]} */
  const errors = [];
  const on = doc.on;
  if (!isRecord(on) || !('pull_request' in on)) {
    errors.push(`${WORKFLOW}: must trigger on pull_request`);
  }
  if (isRecord(on) && 'pull_request_target' in on) {
    errors.push(`${WORKFLOW}: must not use pull_request_target`);
  }
  const push = isRecord(on) ? on.push : undefined;
  if (!isRecord(push) || !Array.isArray(push.branches) || !push.branches.includes('main')) {
    errors.push(`${WORKFLOW}: must trigger on push to main`);
  }
  const schedule = isRecord(on) ? on.schedule : undefined;
  if (!Array.isArray(schedule) || schedule.length === 0) {
    errors.push(`${WORKFLOW}: must have a weekly schedule`);
  }
  const perms = doc.permissions;
  if (!isRecord(perms) || perms.contents !== 'read' || Object.keys(perms).length !== 1) {
    errors.push(`${WORKFLOW}: top-level permissions must be exactly contents: read`);
  }
  if (!/security-events:\s*write/.test(text)) {
    errors.push(`${WORKFLOW}: job needs security-events: write to upload SARIF`);
  }
  for (const lang of ['javascript-typescript', 'go']) {
    if (!new RegExp(`language:\\s*${lang}\\b`).test(text)) {
      errors.push(`${WORKFLOW}: matrix must include ${lang}`);
    }
  }
  if (!text.includes('make build')) errors.push(`${WORKFLOW}: Go must be built with the Makefile`);
  for (const action of ['init', 'analyze']) {
    const pinned = new RegExp(`uses:\\s*github/codeql-action/${action}@[0-9a-f]{40}\\s+#\\s*v\\d`);
    if (!pinned.test(text))
      errors.push(`${WORKFLOW}: codeql-action/${action} must be pinned to a SHA`);
  }
  if (!text.includes('config-file: ./.github/codeql-config.yml')) {
    errors.push(`${WORKFLOW}: must load ${CONFIG}`);
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
  for (const [file, check] of /** @type {const} */ ([
    [WORKFLOW, checkWorkflow],
    [CONFIG, checkConfig],
  ])) {
    const full = path.join(root, file);
    if (!existsSync(full)) errors.push(`${file} is missing`);
    else errors.push(...check(readFileSync(full, 'utf8')));
  }
  return errors;
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const i = argv.indexOf('--root');
  const root = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1] ?? '.') : process.cwd();
  const errors = checkRepo(root);
  for (const e of errors) console.error(e);
  if (errors.length === 0) console.log('codeql policy ok');
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
