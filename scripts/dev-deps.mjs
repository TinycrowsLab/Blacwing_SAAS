#!/usr/bin/env node
// Local dependency stack driver (DEVENV-002, #156).
//
//   node scripts/dev-deps.mjs up              # `pnpm dev:deps`: create .env if missing, start + wait healthy
//   node scripts/dev-deps.mjs reset --yes     # `pnpm dev:deps:reset`: drop the stack AND its volumes
//   node scripts/dev-deps.mjs config          # validate/render the compose file
//
// `.env` is created from `.env.example`; every empty `*_PASSWORD=` gets a random dev value.
// Existing `.env` values are never overwritten, and no credential is ever printed.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSE_FILE = path.join(ROOT, 'infra/compose/docker-compose.dev.yml');
export const PROJECT = 'bwdev';
const PASSWORD_BYTES = 16;

/**
 * Fills empty password entries of an env template with random hex values.
 * Keys already present in `existing` keep their value; missing keys are appended.
 * @param {string} template contents of .env.example
 * @param {string} [existing] contents of the current .env, if any
 * @param {() => string} [gen] password generator
 * @returns {{ text: string, added: string[] }}
 */
export function renderEnv(
  template,
  existing = '',
  gen = () => randomBytes(PASSWORD_BYTES).toString('hex'),
) {
  /** @type {Set<string>} */
  const have = new Set();
  /** @type {Map<string, string>} resolved values, used to expand `${KEY}` references */
  const values = new Map();
  for (const line of existing.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1]) {
      have.add(m[1]);
      values.set(m[1], m[2] ?? '');
    }
  }
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const lines = [];
  for (const line of template.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m?.[1] || have.has(m[1])) continue;
    const key = m[1];
    const raw = m[2] === '' && key.endsWith('_PASSWORD') ? gen() : (m[2] ?? '');
    // `${KEY}` expands to an earlier key's value (e.g. a URL embedding a generated password).
    const value = raw.replace(
      /\$\{([A-Z0-9_]+)\}/g,
      (/** @type {string} */ ref, /** @type {string} */ k) => values.get(k) ?? ref,
    );
    values.set(key, value);
    lines.push(`${key}=${value}`);
    added.push(key);
  }
  if (added.length === 0) return { text: existing, added };
  const base = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  const header =
    existing === '' ? '# Generated from .env.example by `pnpm dev:deps`. Dev only.\n' : '';
  return { text: `${base}${header}${lines.join('\n')}\n`, added };
}

/** @param {string} envFile */
export function ensureEnv(envFile = path.join(ROOT, '.env')) {
  const template = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const { text, added } = renderEnv(template, existing);
  if (added.length > 0) writeFileSync(envFile, text, { mode: 0o600 });
  return added;
}

/**
 * @param {string[]} args
 * @param {string} envFile
 */
function compose(args, envFile) {
  execFileSync(
    'docker',
    ['compose', '-p', PROJECT, '--env-file', envFile, '-f', COMPOSE_FILE, ...args],
    {
      stdio: 'inherit',
    },
  );
}

/** @param {string[]} argv */
export function main(argv) {
  const [cmd = 'up', ...rest] = argv;
  const envFile = path.join(ROOT, '.env');
  if (cmd === 'up') {
    const added = ensureEnv(envFile);
    if (added.length > 0) process.stdout.write(`.env: added ${String(added.length)} keys\n`);
    compose(['up', '-d', '--wait', '--wait-timeout', '300', ...rest], envFile);
    return 0;
  }
  if (cmd === 'config') {
    ensureEnv(envFile);
    compose(['config', '--quiet'], envFile);
    return 0;
  }
  if (cmd === 'reset') {
    if (!rest.includes('--yes')) {
      process.stderr.write(
        'dev:deps:reset drops the shared bwdev stack AND its volumes (pgdata, valkeydata, neo4jdata).\n' +
          'Re-run with --yes: pnpm dev:deps:reset --yes\n',
      );
      return 2;
    }
    compose(['down', '-v', '--remove-orphans'], envFile);
    return 0;
  }
  process.stderr.write(`unknown command: ${cmd} (expected up | config | reset)\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const status = /** @type {{ status?: number }} */ (error).status;
    process.stderr.write(`dev-deps: docker compose failed (exit ${String(status ?? 1)})\n`);
    process.exitCode = 1;
  }
}
