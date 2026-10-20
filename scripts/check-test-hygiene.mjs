#!/usr/bin/env node
// Fails when a test file leaves a focused or skipped test in the tree (CI-003, #137; DoD §10):
//   - `.only` (it/test/describe/suite, Vitest and node:test), `fit`, `fdescribe` always fail;
//   - `.skip`, `.todo`, `xit`, `xtest`, `xdescribe` fail unless the same line or the line above
//     links an issue (`#123`), which marks a tracked, intentional exception.
// Scans *.test.* / *.spec.* files in the repository (git-tracked and untracked, ignoring .gitignore).
//
// Usage: node scripts/check-test-hygiene.mjs [--root <dir>]
// Exits non-zero (listing every offence as file:line) when the tree is not clean.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = /\.(test|spec)\.(?:[cm]?[jt]sx?)$/;
const RUNNERS = String.raw`(?:it|test|describe|suite|context)`;
const FOCUSED = new RegExp(String.raw`(?:\b${RUNNERS}(?:\.\w+)*\.only\b|\b(?:fit|fdescribe)\s*\()`);
const DISABLED = new RegExp(
  String.raw`(?:\b${RUNNERS}(?:\.\w+)*\.(?:skip|todo)\b|\b(?:xit|xtest|xdescribe)\s*\()`,
);
const ISSUE_LINK = /#\d+\b/;
/** Ceiling for the file-listing output (64 MiB). */
const MAX_LIST_BYTES = 0x4_000_000;
/** Its fixtures are deliberately offending snippets. */
const SELF_TEST = 'scripts/check-test-hygiene.test.mjs';

/**
 * @param {string} file repo-relative path, for messages
 * @param {string} text file contents
 * @returns {string[]} problems
 */
export function checkTestFile(file, text) {
  /** @type {string[]} */
  const errors = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const code = line.trimStart();
    // Prose in comments (for example "never use it.skip") is not a test.
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    const where = `${file}:${String(index + 1)}`;
    if (FOCUSED.test(line)) {
      errors.push(`${where}: focused test (.only) would silently skip the rest of the suite`);
    } else if (DISABLED.test(line)) {
      const linked = ISSUE_LINK.test(line) || ISSUE_LINK.test(lines[index - 1] ?? '');
      if (!linked) errors.push(`${where}: skipped or todo test without a linked issue (#N)`);
    }
  });
  return errors;
}

/**
 * @param {string} root repository root
 * @returns {string[]} repo-relative test file paths
 */
export function listTestFiles(root) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: MAX_LIST_BYTES },
  );
  return out
    .split('\0')
    .filter(
      (file) =>
        file !== '' &&
        TEST_FILE.test(file) &&
        !file.startsWith('scripts/fixtures/') &&
        file !== SELF_TEST,
    );
}

/**
 * @param {string} root repository root
 * @returns {string[]} problems
 */
export function checkTree(root) {
  return listTestFiles(root).flatMap((file) => {
    try {
      return checkTestFile(file, readFileSync(path.join(root, file), 'utf8'));
    } catch {
      return []; // deleted but still listed by git
    }
  });
}

/**
 * @param {string[]} argv
 * @returns {{ root: string }}
 */
export function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') root = path.resolve(argv[(i += 1)] ?? root);
  }
  return { root };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { root } = parseArgs(process.argv.slice(2));
  const errors = checkTree(root);
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length > 0) process.exit(1);
  console.log('check-test-hygiene: no focused or unlinked skipped tests');
}
