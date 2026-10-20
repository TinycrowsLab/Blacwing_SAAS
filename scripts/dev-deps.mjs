#!/usr/bin/env node
// Local dependency stack driver (DEVENV-002, #156).
//
//   node scripts/dev-deps.mjs up              # `pnpm dev:deps`: create .env if missing, start, wait healthy,
//                                             #   run the bootstraps in order (DEVENV-010, dev-orchestrate.mjs)
//   node scripts/dev-deps.mjs reset --yes     # `pnpm dev:deps:reset`: drop the stack AND its volumes, recreate
//   node scripts/dev-deps.mjs obs             # `pnpm dev:deps:obs`: core stack + the opt-in `obs` profile (DEVENV-009)
//   node scripts/dev-deps.mjs tls             # `pnpm dev:tls`: mkcert certs + Traefik HTTPS proxy (DEVENV-013)
//   node scripts/dev-deps.mjs config          # validate/render the compose file
//
// `.env` is created from `.env.example`; every empty `*_PASSWORD=` / `*_SECRET=` / `*_TOKEN=` gets a random dev value
// (except `*_CLIENT_SECRET=`: externally issued, e.g. an IdP's OAuth client, filled by hand).
// Existing `.env` values are never overwritten, and no credential is ever printed.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LOCK_FILE,
  DevDepsError,
  acquireLock,
  orchestrateUp,
  realDeps,
} from './dev-orchestrate.mjs';
import { composeRunner, envSecrets } from './wait-for-health.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSE_FILE = path.join(ROOT, 'infra/compose/docker-compose.dev.yml');
export const PROJECT = 'bwdev';
export const SETUP_TLS = path.join(ROOT, 'infra/compose/tls/setup-tls.sh');
const PASSWORD_BYTES = 16;
const POLL_INTERVAL_MS = 1000;
/** Services of the opt-in `obs` compose profile (DEVENV-009). `pnpm dev:deps` never starts them. */
export const OBS_SERVICES = Object.freeze([
  'otel-collector',
  'prometheus',
  'loki',
  'tempo',
  'grafana',
]);

/** Keys whose empty template value is replaced by a random dev secret. @param {string} key */
export function isGeneratedSecret(key) {
  return /_(PASSWORD|SECRET|TOKEN)$/.test(key) && !key.endsWith('_CLIENT_SECRET');
}

/**
 * Fills empty password and token entries of an env template with random hex values.
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
    const raw = m[2] === '' && isGeneratedSecret(key) ? gen() : (m[2] ?? '');
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

/**
 * Parses KEY=VALUE lines of an env file the way compose reads them (no export/quoting extras).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1]) out[m[1]] = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
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
 * Polls `url` until it answers 2xx (for services whose image has no shell to run a healthcheck in).
 * @param {string} url
 * @param {number} timeoutMs
 */
export async function waitForHttp(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
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

/**
 * `.env` values with the shell environment on top (compose precedence), for ports and log scrubbing.
 * @param {string} envFile
 * @returns {Record<string, string | undefined>}
 */
function stackEnv(envFile) {
  const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  return { ...fileEnv, ...process.env };
}

/**
 * @param {string} envFile
 * @param {{ profiles?: string[], extraServices?: string[] }} [opts]
 */
async function orchestrate(envFile, opts = {}) {
  const added = ensureEnv(envFile);
  if (added.length > 0) process.stdout.write(`.env: added ${String(added.length)} keys\n`);
  const deps = realDeps(
    composeRunner(envFile),
    waitForHttp,
    envSecrets(envFile),
    stackEnv(envFile),
  );
  await orchestrateUp(deps, opts);
}

/** @param {string[]} argv */
export async function main(argv) {
  const [cmd = 'up', ...rest] = argv;
  const envFile = path.join(ROOT, '.env');
  if (cmd === 'up') {
    // DEVENV-010: core services -> wait healthy -> ordered bootstraps (scripts/dev-orchestrate.mjs).
    await orchestrate(envFile);
    return 0;
  }
  if (cmd === 'obs') {
    // DEVENV-009: the core bring-up plus the opt-in observability profile. Compose has no healthcheck for
    // the collector (scratch image) or Tempo (no shell), so readiness is polled over their loopback ports.
    await orchestrate(envFile, { profiles: ['obs'], extraServices: [...OBS_SERVICES] });
    const env = stackEnv(envFile);
    const port = (/** @type {string} */ key, /** @type {string} */ dflt) => {
      const v = env[key];
      return v === undefined || v === '' ? dflt : v;
    };
    await waitForHttp(`http://127.0.0.1:${port('BW_DEV_OTEL_HEALTH_PORT', '13133')}/`);
    await waitForHttp(`http://127.0.0.1:${port('BW_DEV_TEMPO_PORT', '13200')}/ready`);
    process.stdout.write(
      `obs profile ready: Grafana http://127.0.0.1:${port('BW_DEV_GRAFANA_PORT', '13001')}, ` +
        `OTLP http://127.0.0.1:${port('BW_DEV_OTEL_HTTP_PORT', '14318')}\n`,
    );
    return 0;
  }
  if (cmd === 'tls') {
    // DEVENV-013: mkcert certs for *.bw.localhost, then the Traefik TLS proxy (compose profile `tls`).
    ensureEnv(envFile);
    execFileSync('bash', [SETUP_TLS], { stdio: 'inherit' });
    compose(
      ['--profile', 'tls', 'up', '-d', '--wait', '--wait-timeout', '120', 'traefik'],
      envFile,
    );
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
        'dev:deps:reset drops the shared bwdev stack AND its volumes (pgdata incl. Keycloak, valkeydata, neo4jdata, miniodata, openbaodata),\n' +
          'then recreates it from scratch with every bootstrap.\n' +
          'Re-run with --yes: pnpm dev:deps:reset --yes\n',
      );
      return 2;
    }
    // Under the same lock as `up`, so a reset never races a running bring-up.
    const release = acquireLock(DEFAULT_LOCK_FILE);
    try {
      compose(['--profile', 'obs', 'down', '-v', '--remove-orphans'], envFile);
      // OpenBao's app token / init state live outside the volumes; a fresh OpenBao must issue new ones.
      rmSync(path.join(ROOT, '.bw-dev/openbao'), { recursive: true, force: true });
    } finally {
      release();
    }
    await orchestrate(envFile);
    return 0;
  }
  process.stderr.write(`unknown command: ${cmd} (expected up | obs | tls | config | reset)\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof DevDepsError) {
      process.stderr.write(
        `dev-deps: ${error.message}\n${error.hint ? `hint: ${error.hint}\n` : ''}`,
      );
    } else {
      const status = /** @type {{ status?: number }} */ (error).status;
      process.stderr.write(`dev-deps: docker compose failed (exit ${String(status ?? 1)})\n`);
    }
    process.exitCode = 1;
  }
}
