#!/usr/bin/env node
// Summarises a gitleaks SARIF report as counts only (CI-012, #146). It never prints a secret, a
// snippet, a file path or a line: just how many findings each rule produced, so the job summary
// stays safe to share even if a report was produced without `--redact`.
//
// Usage: node scripts/gitleaks-summary.mjs <report.sarif> [--mode <pr|push|full>]
// Writes Markdown to stdout and, when GITHUB_STEP_SUMMARY is set, appends it there.
// Exits 2 when the report is missing or is not SARIF; the scan step owns pass/fail on findings.

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Counts findings per rule id in a parsed SARIF document.
 * @param {unknown} sarif
 * @returns {{ total: number, byRule: Map<string, number> }}
 */
export function countFindings(sarif) {
  if (!isRecord(sarif) || !Array.isArray(sarif.runs)) {
    throw new TypeError('not a SARIF document (no runs array)');
  }
  /** @type {Map<string, number>} */
  const byRule = new Map();
  let total = 0;
  for (const run of sarif.runs) {
    const results = isRecord(run) && Array.isArray(run.results) ? run.results : [];
    for (const result of results) {
      const rule =
        isRecord(result) &&
        typeof result.ruleId === 'string' &&
        /^[\w.-]{1,100}$/.test(result.ruleId)
          ? result.ruleId
          : 'unknown-rule';
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      total += 1;
    }
  }
  return { total, byRule };
}

/**
 * Renders the counts-only Markdown summary.
 * @param {{ total: number, byRule: Map<string, number> }} counts
 * @param {string} mode which scan produced the report
 * @returns {string}
 */
export function renderSummary(counts, mode) {
  const lines = [`### Secret scan (gitleaks, ${mode})`, ''];
  if (counts.total === 0) {
    lines.push('No secrets found.');
  } else {
    lines.push(
      `**${String(counts.total)} finding(s)**, values redacted. Details are in the Security tab (code scanning, category \`gitleaks\`).`,
      '',
      '| Rule | Findings |',
      '|---|---|',
    );
    for (const [rule, count] of [...counts.byRule].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`| \`${rule}\` | ${String(count)} |`);
    }
    lines.push(
      '',
      'Rotate any real credential first, then remove it: docs/runbooks/secret-scanning.md.',
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {number} exit code
 */
export function main(argv, env) {
  const [report, flag, mode = 'scan'] = argv;
  if (report === undefined || (flag !== undefined && flag !== '--mode')) {
    process.stderr.write('usage: gitleaks-summary.mjs <report.sarif> [--mode <pr|push|full>]\n');
    return 2;
  }
  /** @type {{ total: number, byRule: Map<string, number> }} */
  let counts;
  try {
    counts = countFindings(JSON.parse(readFileSync(report, 'utf8')));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`gitleaks-summary: cannot read SARIF report ${report}: ${reason}\n`);
    return 2;
  }
  const markdown = renderSummary(counts, /^[\w-]{1,20}$/.test(mode) ? mode : 'scan');
  process.stdout.write(markdown);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
