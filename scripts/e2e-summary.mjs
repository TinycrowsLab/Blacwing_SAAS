#!/usr/bin/env node
// Markdown step summary of the e2e job (CI-006, #140) from Playwright's JSON reporter output.
//
//   node scripts/e2e-summary.mjs <results.json>   # OUTCOME env = the job status
//
// Prints pass/fail counts and the titles of failed or flaky tests. When the suite never ran (a setup
// step failed first), it says so and points at the health-wait output. Titles only, never test output.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ title: string, status?: string, specs?: Spec[], suites?: Suite[] }} Suite
 * @typedef {{ title: string, tests?: { projectName?: string, status?: string }[] }} Spec
 * @typedef {{ stats?: { expected?: number, unexpected?: number, flaky?: number, skipped?: number },
 *   suites?: Suite[] }} Report
 */

/**
 * @param {Suite[]} suites
 * @param {string[]} trail
 * @returns {{ title: string, status: string }[]}
 */
function walk(suites, trail = []) {
  /** @type {{ title: string, status: string }[]} */
  const out = [];
  for (const suite of suites) {
    const here = suite.title ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.status === 'unexpected' || t.status === 'flaky') {
          out.push({
            title: `[${t.projectName ?? '?'}] ${[...here, spec.title].join(' › ')}`,
            status: t.status,
          });
        }
      }
    }
    out.push(...walk(suite.suites ?? [], here));
  }
  return out;
}

/**
 * @param {Report | undefined} report parsed results.json, or undefined when the suite never ran
 * @param {string} outcome job status
 * @returns {string} markdown
 */
export function renderSummary(report, outcome) {
  const lines = [`### e2e: ${outcome}`, ''];
  if (report === undefined) {
    lines.push(
      'Playwright did not run: a setup step failed first. The health-wait output names the failing ' +
        'service and its last log lines.',
    );
  } else {
    const s = report.stats ?? {};
    lines.push(
      `| passed | failed | flaky | skipped |`,
      `|---|---|---|---|`,
      `| ${String(s.expected ?? 0)} | ${String(s.unexpected ?? 0)} | ${String(s.flaky ?? 0)} | ${String(s.skipped ?? 0)} |`,
    );
    const bad = walk(report.suites ?? []);
    if (bad.length > 0) {
      lines.push(
        '',
        ...bad.map((b) => `- ${b.status === 'flaky' ? 'flaky' : 'failed'}: ${b.title}`),
      );
    }
  }
  lines.push(
    '',
    'On failure the report, traces, videos and screenshots are in the `e2e-playwright` artifact.',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function main(argv, env = process.env) {
  const file = argv[0];
  /** @type {Report | undefined} */
  let report;
  if (file !== undefined && existsSync(file)) {
    try {
      const raw = /** @type {unknown} */ (JSON.parse(readFileSync(file, 'utf8')));
      report = /** @type {Report} */ (raw);
    } catch {
      report = undefined;
    }
  }
  return renderSummary(report, env.OUTCOME ?? 'unknown');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(main(process.argv.slice(2)));
}
