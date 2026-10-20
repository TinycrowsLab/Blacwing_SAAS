#!/usr/bin/env node
// Onboarding/CI helper (DEVENV-003, #157): diffs `.env` against `.env.example` and reports missing
// keys. Prints key names only, never values.
//
//   node scripts/check-env.mjs [--env <file>] [--example <file>]
//
// Exit 0 when every key of the example is set (non-empty) in .env, 1 when keys are missing or empty,
// 2 when a file cannot be read. The `BW_DEV_GOOGLE_*` SSO inputs are optional and may stay empty.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Parses dotenv text into a key -> value map. Comments and blank lines are ignored; CRLF is
 * tolerated; surrounding quotes are stripped.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnv(text) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trimStart().startsWith('#')) continue;
    const m = LINE.exec(raw);
    if (!m?.[1]) continue;
    out.set(m[1], (m[2] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2'));
  }
  return out;
}

/** Keys that may stay empty because the owner supplies them out of band. */
export const OPTIONAL_EMPTY = new Set([
  'BW_DEV_GOOGLE_CLIENT_ID',
  'BW_DEV_GOOGLE_CLIENT_SECRET',
  // Temporal mTLS PEM paths: only needed when TEMPORAL_TLS_ENABLED=true (not the plain dev server).
  'TEMPORAL_CLIENT_CERT_PATH',
  'TEMPORAL_CLIENT_KEY_PATH',
  // apps/worker queue subset: empty means every queue.
  'WORKER_TASK_QUEUES',
  // Model-gateway provider credential: the dev mock upstream needs none (.env.example).
  'GATEWAY_ANTHROPIC_API_KEY',
]);

/**
 * @param {string} example contents of .env.example
 * @param {string} actual contents of .env
 * @returns {{ missing: string[], empty: string[], extra: string[] }}
 */
export function diffEnv(example, actual) {
  const want = parseEnv(example);
  const have = parseEnv(actual);
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const empty = [];
  for (const key of want.keys()) {
    if (!have.has(key)) missing.push(key);
    else if (have.get(key) === '' && !OPTIONAL_EMPTY.has(key)) empty.push(key);
  }
  const extra = [...have.keys()].filter((k) => !want.has(k));
  return { missing, empty, extra };
}

/**
 * @param {string[]} argv
 * @param {{ out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  let envFile = path.join(ROOT, '.env');
  let exampleFile = path.join(ROOT, '.env.example');
  for (let i = 0; i < argv.length; i += 2) {
    const val = argv[i + 1];
    if (argv[i] === '--env' && val) envFile = path.resolve(val);
    else if (argv[i] === '--example' && val) exampleFile = path.resolve(val);
    else {
      err('usage: check-env.mjs [--env <file>] [--example <file>]\n');
      return 2;
    }
  }
  if (!existsSync(exampleFile)) {
    err(`check-env: ${exampleFile} not found\n`);
    return 2;
  }
  if (!existsSync(envFile)) {
    err('check-env: .env not found. Run `pnpm dev:deps` (or copy .env.example to .env).\n');
    return 2;
  }
  const { missing, empty, extra } = diffEnv(
    readFileSync(exampleFile, 'utf8'),
    readFileSync(envFile, 'utf8'),
  );
  if (extra.length > 0) {
    out(`check-env: ${String(extra.length)} key(s) not in the example: ${extra.join(', ')}\n`);
  }
  if (missing.length === 0 && empty.length === 0) {
    out('check-env: ok\n');
    return 0;
  }
  if (missing.length > 0) err(`check-env: missing keys: ${missing.join(', ')}\n`);
  if (empty.length > 0) err(`check-env: empty keys: ${empty.join(', ')}\n`);
  err('check-env: add them from .env.example (`pnpm dev:deps` fills passwords).\n');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
