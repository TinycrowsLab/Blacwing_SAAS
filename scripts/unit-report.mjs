#!/usr/bin/env node
// Gate and report for the CI unit-test job (CI-003, #137). After `vitest run --coverage` ran in every
// workspace member (scripts/ci-unit.mjs), this reads each member's coverage/coverage-summary.json and
// junit.xml and:
//   - fails when any coverage metric (lines, statements, functions, branches) is under the member's
//     floor in coverage-thresholds.json (per-member entry, else "default"), or when a member that ran
//     tests emitted no coverage summary;
//   - fails when junit.xml reports skipped tests (the hygiene guard allows only issue-linked skips,
//     and a skip is never silent in CI) or when a member emitted no coverage/junit.xml;
//   - writes a markdown step summary (pass/fail/skip counts, coverage per member) to
//     $GITHUB_STEP_SUMMARY when set, or stdout with --summary-stdout.
//
// Floors only ratchet up: raise a member's entry when its coverage improves; never lower one.
//
// Usage: node scripts/unit-report.mjs [--root <dir>] [--summary-stdout]

import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const METRICS = Object.freeze(['lines', 'statements', 'functions', 'branches']);
const MAX_PCT = 100;
export const THRESHOLDS_FILE = 'coverage-thresholds.json';

/**
 * @typedef {Record<string, number | undefined>} Floors
 * @typedef {{ default: Floors, packages: Record<string, Partial<Floors>> }} Thresholds
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates the thresholds file.
 * @param {unknown} raw parsed JSON
 * @returns {{ thresholds: Thresholds | null, errors: string[] }}
 */
export function parseThresholds(raw) {
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(raw) || !isRecord(raw.default) || !isRecord(raw.packages)) {
    return { thresholds: null, errors: [`${THRESHOLDS_FILE}: expected { default, packages }`] };
  }
  /**
   * @param {string} label
   * @param {Record<string, unknown>} floors
   */
  const checkFloors = (label, floors) => {
    for (const [metric, value] of Object.entries(floors)) {
      if (!METRICS.includes(metric)) errors.push(`${label}: unknown metric "${metric}"`);
      else if (typeof value !== 'number' || !(value >= 0 && value <= MAX_PCT))
        errors.push(`${label}.${metric}: must be a number between 0 and 100`);
    }
  };
  checkFloors('default', raw.default);
  for (const metric of METRICS) {
    if (!(metric in raw.default)) errors.push(`default.${metric}: missing`);
  }
  for (const [name, floors] of Object.entries(raw.packages)) {
    if (isRecord(floors)) checkFloors(`packages.${name}`, floors);
    else errors.push(`packages.${name}: expected an object`);
  }
  if (errors.length > 0) return { thresholds: null, errors };
  return { thresholds: /** @type {Thresholds} */ (/** @type {unknown} */ (raw)), errors };
}

/**
 * @param {Thresholds} thresholds
 * @param {string} name package name, e.g. "@blackwing/errors"
 * @returns {Floors}
 */
export function floorsFor(thresholds, name) {
  return { ...thresholds.default, ...thresholds.packages[name] };
}

/**
 * Compares one coverage summary to its floors.
 * @param {string} name
 * @param {unknown} summary parsed coverage-summary.json
 * @param {Floors} floors
 * @returns {{ errors: string[], pct: Record<string, number | null> }}
 */
export function checkCoverage(name, summary, floors) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, number | null>} */
  const pct = {};
  const total = isRecord(summary) && isRecord(summary.total) ? summary.total : null;
  if (total === null) return { errors: [`${name}: coverage summary has no "total"`], pct };
  for (const metric of METRICS) {
    const entry = total[metric];
    const value = isRecord(entry) ? entry.pct : undefined;
    const totalCount = isRecord(entry) ? entry.total : undefined;
    // Nothing to cover (e.g. a package with no branches) reports "Unknown" and cannot regress.
    if (totalCount === 0) {
      pct[metric] = null;
      continue;
    }
    if (typeof value !== 'number') {
      errors.push(`${name}: coverage ${metric} is unreadable`);
      pct[metric] = null;
      continue;
    }
    pct[metric] = value;
    const floor = floors[metric] ?? 0;
    if (value < floor) {
      errors.push(
        `${name}: ${metric} coverage ${String(value)}% is below the floor of ${String(floor)}%`,
      );
    }
  }
  return { errors, pct };
}

/**
 * Totals from a Vitest JUnit report (root <testsuites tests failures errors skipped>).
 * @param {string} xml
 * @returns {{ tests: number, failures: number, skipped: number } | null}
 */
export function parseJunit(xml) {
  const root = /<testsuites\b([^>]*)>/.exec(xml);
  if (root === null) return null;
  /** @param {string} key */
  const attr = (key) => {
    const match = new RegExp(`\\b${key}="(\\d+)"`).exec(root[1] ?? '');
    return match === null ? 0 : Number(match[1]);
  };
  return {
    tests: attr('tests'),
    failures: attr('failures') + attr('errors'),
    skipped: attr('skipped'),
  };
}

/**
 * @param {string} root repository root
 * @returns {{ dir: string, name: string }[]} workspace members (apps/*, packages/*) that define a test script
 */
export function testMembers(root) {
  /** @type {{ dir: string, name: string }[]} */
  const members = [];
  for (const group of ['apps', 'packages']) {
    const base = path.join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(base, entry.name, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = /** @type {unknown} */ (JSON.parse(readFileSync(manifest, 'utf8')));
      if (!isRecord(pkg) || !isRecord(pkg.scripts) || typeof pkg.scripts.test !== 'string')
        continue;
      members.push({ dir: path.join(base, entry.name), name: String(pkg.name) });
    }
  }
  return members.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {string} root repository root
 * @returns {{ errors: string[], summary: string }}
 */
export function buildReport(root) {
  /** @type {string[]} */
  const errors = [];
  const thresholdsPath = path.join(root, THRESHOLDS_FILE);
  const parsed = parseThresholds(
    existsSync(thresholdsPath) ? JSON.parse(readFileSync(thresholdsPath, 'utf8')) : null,
  );
  errors.push(...parsed.errors);
  const thresholds = parsed.thresholds;

  let tests = 0;
  let failures = 0;
  let skipped = 0;
  const rows = [
    '| Package | Tests | Skipped | Lines | Statements | Functions | Branches |',
    '|---|---|---|---|---|---|---|',
  ];
  /** @param {number | null | undefined} value */
  const cell = (value) => (typeof value === 'number' ? `${String(value)}%` : 'n/a');

  for (const member of testMembers(root)) {
    const junitPath = path.join(member.dir, 'coverage', 'junit.xml');
    const junit = existsSync(junitPath) ? parseJunit(readFileSync(junitPath, 'utf8')) : null;
    if (junit === null) {
      errors.push(`${member.name}: no coverage/junit.xml (did the unit run reach this package?)`);
    } else {
      tests += junit.tests;
      failures += junit.failures;
      skipped += junit.skipped;
      if (junit.skipped > 0)
        errors.push(`${member.name}: ${String(junit.skipped)} skipped test(s)`);
      if (junit.failures > 0)
        errors.push(`${member.name}: ${String(junit.failures)} failing test(s)`);
    }

    const summaryPath = path.join(member.dir, 'coverage', 'coverage-summary.json');
    /** @type {Record<string, number | null>} */
    let pct = {};
    if (!existsSync(summaryPath)) {
      errors.push(`${member.name}: no coverage/coverage-summary.json`);
    } else if (thresholds !== null) {
      const result = checkCoverage(
        member.name,
        JSON.parse(readFileSync(summaryPath, 'utf8')),
        floorsFor(thresholds, member.name),
      );
      errors.push(...result.errors);
      pct = result.pct;
    }
    rows.push(
      `| ${member.name} | ${String(junit?.tests ?? 0)} | ${String(junit?.skipped ?? 0)} | ${METRICS.map((m) => cell(pct[m])).join(' | ')} |`,
    );
  }

  const status = errors.length === 0 ? 'passed' : 'FAILED';
  const summary = [
    `## Unit tests: ${status}`,
    '',
    `${String(tests)} tests, ${String(failures)} failed, ${String(skipped)} skipped.`,
    '',
    ...rows,
    ...(errors.length > 0 ? ['', '### Problems', ...errors.map((e) => `- ${e}`)] : []),
    '',
  ].join('\n');
  return { errors, summary };
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, stdout: boolean }}
 */
export function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let stdout = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') root = path.resolve(argv[(i += 1)] ?? root);
    else if (argv[i] === '--summary-stdout') stdout = true;
  }
  return { root, stdout };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { root, stdout } = parseArgs(process.argv.slice(2));
  const { errors, summary } = buildReport(root);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary !== undefined && stepSummary !== '') appendFileSync(stepSummary, summary);
  if (stdout || stepSummary === undefined || stepSummary === '') console.log(summary);
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length > 0) process.exit(1);
}
