#!/usr/bin/env node
// Guards the operator runbooks (issue #817) against drift from the product and the Context Pack.
//
// For each operator runbook under docs/runbooks/ it detects:
//   - a missing file, or front matter without `last_validated: never` or a real `YYYY-MM-DD` date;
//   - a missing `## Validation` section (a runbook without a validation procedure is not a runbook);
//   - relative links to files that do not exist, and `#anchors` that match no heading in the target;
//   - `pnpm <script>` references that package.json does not define;
//   - `bw_*` metric names that no non-test source file under apps/ or packages/ defines;
//   - `§N` references to Context Pack sections that do not exist (`§8.5` checks section 8).
//
// External links are not fetched. Their check belongs to the docs link-check.
//
// Usage: node scripts/check-runbooks.mjs [--root <dir>] [--quiet]
// Prints a structured JSON summary on stdout; exits non-zero when any check fails.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractLinks, headingAnchors, numberedSections } from './check-claude-md.mjs';

const RUNBOOK_DIR = 'docs/runbooks';
const CONTEXT_PACK = 'docs/architecture/CONTEXT_PACK.md';
const PACKAGE_JSON = 'package.json';

/** The runbooks this check covers (issue #817). */
export const OPERATOR_RUNBOOKS = Object.freeze([
  'deploy-rollback.md',
  'disaster-recovery.md',
  'incident-response.md',
  'kill-switch.md',
]);

/** Where `bw_*` metrics are defined. */
const METRIC_SOURCE_DIRS = Object.freeze(['apps', 'packages']);

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);
const SOURCE_FILE = /\.(ts|tsx|mjs|js|go)$/;
const TEST_FILE = /(\.test\.|\.spec\.|_test\.go$)/;
const METRIC_TOKEN = /\bbw_[a-z0-9_]*[a-z0-9]\b/g;
const PNPM_SCRIPT = /\bpnpm\s+([a-z][\w:-]*)/g;
const SECTION_REF = /§(\d+)(?:\.\d+)*/g;
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;
const LAST_VALIDATED = /^last_validated:\s*(never|\d{4}-\d{2}-\d{2})\s*$/m;
/** Length of an ISO-8601 calendar date (`YYYY-MM-DD`). */
const ISO_DATE_LENGTH = 10;

/**
 * @param {string} value `never` or a `YYYY-MM-DD` date that exists (2026-02-30 does not).
 * @returns {boolean}
 */
export function isValidValidationStamp(value) {
  if (value === 'never') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, ISO_DATE_LENGTH) === value
  );
}

/**
 * Collects every `bw_*` metric token defined in non-test source under the metric source directories.
 * @param {string} root
 * @returns {Set<string>}
 */
function collectMetricNames(root) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        const text = readFileSync(path.join(dir, entry.name), 'utf8');
        for (const match of text.matchAll(METRIC_TOKEN)) names.add(match[0]);
      }
    }
  };
  for (const dir of METRIC_SOURCE_DIRS) {
    const abs = path.join(root, dir);
    if (existsSync(abs)) walk(abs);
  }
  return names;
}

/**
 * Checks the operator runbooks against the repository at `root`.
 * @param {string} root
 * @returns {{ ok: boolean, errors: string[], checked: string[] }}
 */
export function checkRunbooks(root) {
  /** @type {string[]} */
  const errors = [];
  const packPath = path.join(root, CONTEXT_PACK);
  const packText = existsSync(packPath) ? readFileSync(packPath, 'utf8') : undefined;
  if (packText === undefined) errors.push(`${CONTEXT_PACK}: missing Context Pack`);
  const sections = new Set(
    [...numberedSections(packText ?? '').values()].map((number) => number.split('.')[0] ?? ''),
  );

  const pkgPath = path.join(root, PACKAGE_JSON);
  /** @type {Set<string>} */
  const scripts = new Set();
  if (existsSync(pkgPath)) {
    /** @type {unknown} */
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const defined =
      typeof pkg === 'object' && pkg !== null && 'scripts' in pkg ? pkg.scripts : undefined;
    if (typeof defined === 'object' && defined !== null) {
      for (const name of Object.keys(defined)) scripts.add(name);
    }
  } else {
    errors.push(`${PACKAGE_JSON}: missing`);
  }
  const metrics = collectMetricNames(root);

  for (const name of OPERATOR_RUNBOOKS) {
    const rel = `${RUNBOOK_DIR}/${name}`;
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      errors.push(`${rel}: missing runbook`);
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    checkRunbookText(rel, text, { root, sections, scripts, metrics, errors });
  }
  return { ok: errors.length === 0, errors, checked: [...OPERATOR_RUNBOOKS] };
}

/**
 * @param {string} rel repository-relative runbook path
 * @param {string} text
 * @param {{ root: string, sections: Set<string>, scripts: Set<string>, metrics: Set<string>, errors: string[] }} ctx
 */
function checkRunbookText(rel, text, ctx) {
  const { errors } = ctx;
  const front = FRONT_MATTER.exec(text)?.[1];
  const stamp = front === undefined ? undefined : LAST_VALIDATED.exec(front)?.[1];
  if (stamp === undefined) {
    errors.push(`${rel}: front matter needs last_validated: never or a YYYY-MM-DD date`);
  } else if (!isValidValidationStamp(stamp)) {
    errors.push(`${rel}: last_validated ${stamp} is not a real date`);
  }

  if (!headingAnchors(text).has('validation')) {
    errors.push(`${rel}: missing a "## Validation" section`);
  }

  for (const link of extractLinks(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
    const [file = '', anchor] = link.split('#');
    const target =
      file === '' ? path.join(ctx.root, rel) : path.resolve(ctx.root, path.dirname(rel), file);
    if (!existsSync(target)) {
      errors.push(`${rel}: link ${link} points to a file that does not exist`);
      continue;
    }
    if (anchor !== undefined && anchor !== '' && target.endsWith('.md')) {
      const anchors = headingAnchors(readFileSync(target, 'utf8'));
      if (!anchors.has(anchor)) errors.push(`${rel}: link ${link} has no matching heading anchor`);
    }
  }

  for (const match of text.matchAll(PNPM_SCRIPT)) {
    const script = match[1] ?? '';
    if (!ctx.scripts.has(script))
      errors.push(`${rel}: pnpm ${script} is not a package.json script`);
  }

  for (const match of text.matchAll(METRIC_TOKEN)) {
    if (!ctx.metrics.has(match[0])) {
      errors.push(`${rel}: metric ${match[0]} is not defined in apps/ or packages/`);
    }
  }

  for (const match of text.matchAll(SECTION_REF)) {
    if (!ctx.sections.has(match[1] ?? ''))
      errors.push(`${rel}: §${match[1] ?? ''} is not a Context Pack section`);
  }
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, quiet: boolean }}
 */
export function parseArgs(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let root = repoRoot;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--root needs a directory');
      root = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return { root, quiet };
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `check-runbooks: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const result = checkRunbooks(args.root);
  if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(
      `check-runbooks: ${result.errors.length} problem(s) found:\n` +
        result.errors.map((e) => `  - ${e}`).join('\n') +
        '\n',
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
