#!/usr/bin/env node
// Normalises Turborepo task output for the GitHub problem matchers (CI-002, #136).
//
// `pnpm lint` / `pnpm typecheck` run through Turborepo, which prefixes every line with
// `<package>:<task>: ` and runs tsc from the package directory, so tsc reports paths relative to
// the package. A problem matcher cannot strip the prefix or re-root a path, so this filter does it:
// it reads the Turborepo log on stdin and writes it to stdout unchanged, except that every
// diagnostic becomes one canonical, repository-relative line:
//
//   tsc     packages/ids/src/a.ts(3,7): error TS2322: Type 'string' is not assignable ...
//   eslint  packages/ids/src/a.ts:3:7: error Unexpected any. Specify a different type. [@typescript-eslint/no-explicit-any]
//
// The matchers in .github/actions/problem-matchers turn those lines into inline PR annotations.
// When GITHUB_STEP_SUMMARY is set, a Markdown job summary (diagnostic counts, the first
// diagnostics, Turborepo cache hits) is appended to it.
//
// Usage: <turbo command> 2>&1 | node scripts/ci-annotate.mjs --task <lint|typecheck> [--root <dir>]
// It always exits 0: the job's result comes from the piped command (run under `set -o pipefail`).
// Only node: built-ins are used so it runs before or without `pnpm install`.

import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** First diagnostics listed in the job summary; the rest are counted only. */
export const SUMMARY_LIMIT = 50;

/** `<package>:<task>: <rest>`; package names never contain ':' or spaces, task names may (lint:root). */
const TURBO_PREFIX = /^([^\s:]+):(\S+?):(?: (.*))?$/;
const TSC_DIAGNOSTIC = /^([^\s(][^(]*)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const ESLINT_FILE = /^(?:\/|[A-Za-z]:[\\/])\S.*$/;
const ESLINT_MESSAGE = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/;
/** pnpm echoes `> <name>@<version> <script> <absolute package dir>` before each script. */
const PNPM_BANNER = /^> (\S+)@\S+ \S+ (\/\S.*|[A-Za-z]:[\\/].*)$/;
const TURBO_CACHED = /^\s*Cached:\s+(\d+) cached, (\d+) total/;

/**
 * @typedef {{ tool: 'tsc' | 'eslint', file: string, line: number, column: number,
 *   severity: 'error' | 'warning', code: string, message: string, pkg: string }} Diagnostic
 */

/**
 * Maps every workspace package name (and Turborepo's `//` root alias) to its repo-relative dir.
 * @param {string} root repository root
 * @returns {Map<string, string>}
 */
export function workspaceDirs(root) {
  /** @type {Map<string, string>} */
  const dirs = new Map([['//', '.']]);
  /** @param {string} rel */
  const add = (rel) => {
    const file = path.join(root, rel, 'package.json');
    if (!existsSync(file)) return;
    /** @type {unknown} */
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof pkg === 'object' && pkg !== null && 'name' in pkg && typeof pkg.name === 'string') {
      dirs.set(pkg.name, rel);
    }
  };
  add('.');
  for (const group of ['apps', 'packages']) {
    const abs = path.join(root, group);
    if (!existsSync(abs)) continue;
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      if (d.isDirectory()) add(`${group}/${d.name}`);
    }
  }
  return dirs;
}

/**
 * @param {string} root
 * @param {string} base repo-relative directory the path is relative to
 * @param {string} file path as printed by the tool
 * @returns {string} forward-slash path relative to the repository root
 */
function repoRelative(root, base, file) {
  const abs = path.isAbsolute(file) ? file : path.join(root, base, file);
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * Stateful line normaliser.
 * @param {{ root: string, dirs: Map<string, string> }} options
 */
export function createNormalizer({ root, dirs }) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** Current ESLint stylish file per package (stylish prints the file once, then its messages). */
  /** @type {Map<string, string>} */
  const eslintFile = new Map();
  /** @type {{ cached: number, total: number } | null} */
  let cache = null;

  /**
   * @param {string} raw one line of Turborepo output
   * @returns {string} the line to print
   */
  function line(raw) {
    const prefixed = TURBO_PREFIX.exec(raw);
    const pkg = prefixed?.[1] ?? '//';
    const rest = prefixed === null ? raw : (prefixed[3] ?? '');

    const cached = TURBO_CACHED.exec(raw);
    if (cached !== null) cache = { cached: Number(cached[1]), total: Number(cached[2]) };

    const banner = PNPM_BANNER.exec(rest);
    if (banner !== null && !dirs.has(pkg)) {
      dirs.set(pkg, repoRelative(root, '.', banner[2] ?? '.'));
    }
    const base = dirs.get(pkg) ?? '.';

    const tsc = TSC_DIAGNOSTIC.exec(rest);
    if (tsc !== null) {
      /** @type {Diagnostic} */
      const d = {
        tool: 'tsc',
        file: repoRelative(root, base, tsc[1] ?? ''),
        line: Number(tsc[2]),
        column: Number(tsc[3]),
        severity: tsc[4] === 'warning' ? 'warning' : 'error',
        code: tsc[5] ?? '',
        message: tsc[6] ?? '',
        pkg,
      };
      diagnostics.push(d);
      return `${d.file}(${String(d.line)},${String(d.column)}): ${d.severity} ${d.code}: ${d.message}`;
    }

    if (rest.trim() === '') {
      eslintFile.delete(pkg);
      return raw;
    }
    if (ESLINT_FILE.test(rest)) {
      eslintFile.set(pkg, repoRelative(root, base, rest.trim()));
      return raw;
    }
    const current = eslintFile.get(pkg);
    const message = current === undefined ? null : ESLINT_MESSAGE.exec(rest);
    if (current !== undefined && message !== null) {
      /** @type {Diagnostic} */
      const d = {
        tool: 'eslint',
        file: current,
        line: Number(message[1]),
        column: Number(message[2]),
        severity: message[3] === 'warning' ? 'warning' : 'error',
        code: message[5] ?? '',
        message: message[4] ?? '',
        pkg,
      };
      diagnostics.push(d);
      const rule = d.code === '' ? '' : ` [${d.code}]`;
      return `${d.file}:${String(d.line)}:${String(d.column)}: ${d.severity} ${d.message}${rule}`;
    }
    return raw;
  }

  return {
    line,
    diagnostics: () => diagnostics,
    cache: () => cache,
  };
}

/**
 * @param {string} task
 * @param {Diagnostic[]} diagnostics
 * @param {{ cached: number, total: number } | null} cache
 * @returns {string} Markdown job summary
 */
export function summarize(task, diagnostics, cache) {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  const out = [`### ${task}`, ''];
  out.push(
    diagnostics.length === 0
      ? 'No diagnostics.'
      : `${String(errors)} error(s), ${String(warnings)} warning(s).`,
  );
  if (cache !== null) {
    const full =
      cache.total > 0 && cache.cached === cache.total ? ' (full Turborepo cache hit)' : '';
    out.push(
      '',
      `Turborepo cache: ${String(cache.cached)}/${String(cache.total)} tasks cached${full}.`,
    );
  }
  if (diagnostics.length > 0) {
    out.push('', '| File | Line | Severity | Code | Message |', '|---|---|---|---|---|');
    for (const d of diagnostics.slice(0, SUMMARY_LIMIT)) {
      const msg = d.message.replaceAll('|', '\\|');
      out.push(`| \`${d.file}\` | ${String(d.line)} | ${d.severity} | ${d.code} | ${msg} |`);
    }
    if (diagnostics.length > SUMMARY_LIMIT) {
      out.push(
        '',
        `${String(diagnostics.length - SUMMARY_LIMIT)} more not shown; see the job log.`,
      );
    }
  }
  return `${out.join('\n')}\n`;
}

/** @param {string[]} argv */
async function main(argv) {
  /** @param {string} flag */
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(
    arg('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  );
  const task = arg('--task') ?? 'turbo';
  const normalizer = createNormalizer({ root, dirs: workspaceDirs(root) });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const raw of rl) process.stdout.write(`${normalizer.line(raw)}\n`);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile !== undefined && summaryFile !== '') {
    appendFileSync(summaryFile, summarize(task, normalizer.diagnostics(), normalizer.cache()));
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main(process.argv.slice(2));
}
