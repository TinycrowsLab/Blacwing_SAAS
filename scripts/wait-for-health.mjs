#!/usr/bin/env node
// Waits until compose services of the dev stack are healthy (DEVENV-010, #164).
//
//   node scripts/wait-for-health.mjs [--timeout <seconds>] [--one-shot <svc>]... <svc>...
//
// Polls `docker compose ps --all --format json` and prints a per-service status table. A long-running
// service is ready when its healthcheck reports `healthy` (or, without a healthcheck, when it runs); a
// one-shot job is ready when it exited 0. Fails fast when a service is `unhealthy`, exited non-zero or
// is missing, and on timeout; either way the failing services are named and their log tail is printed
// with credential-looking lines and known secret values redacted (CONTEXT_PACK §8.7).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra/compose/docker-compose.dev.yml');
const PROJECT = 'bwdev';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_INTERVAL_MS = 2000;
const LOG_TAIL_LINES = 30;
const MS_PER_SECOND = 1000;
const MIN_SERVICE_COLUMN = 'SERVICE'.length;
const STAT_COLUMN = 'STAT'.length;
/** Shorter values (e.g. `true`, ports) would scrub unrelated text without protecting anything. */
const MIN_SECRET_LENGTH = 6;

/**
 * @typedef {{ Service: string, State: string, Health: string, ExitCode: number }} PsEntry
 * @typedef {'ready' | 'starting' | 'failed'} Verdict
 * @typedef {{ service: string, verdict: Verdict, detail: string }} ServiceStatus
 * @typedef {(args: string[]) => { status: number | null, stdout: string, stderr: string }} Runner
 */

/** @param {unknown} v */
function asRecord(v) {
  return v !== null && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v) : {};
}

/**
 * Parses `docker compose ps --format json` output: a JSON array (compose < 2.21) or one object per line.
 * @param {string} text
 * @returns {PsEntry[]}
 */
export function parseComposePs(text) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  /** @type {unknown[]} */
  const raw = trimmed.startsWith('[')
    ? /** @type {unknown[]} */ (JSON.parse(trimmed))
    : trimmed
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => /** @type {unknown} */ (JSON.parse(l)));
  return raw.map((item) => {
    const r = asRecord(item);
    return {
      Service: typeof r.Service === 'string' ? r.Service : '',
      State: typeof r.State === 'string' ? r.State.toLowerCase() : '',
      Health: typeof r.Health === 'string' ? r.Health.toLowerCase() : '',
      ExitCode: Number(r.ExitCode ?? 0),
    };
  });
}

/**
 * @param {PsEntry | undefined} entry
 * @param {boolean} oneShot
 * @returns {{ verdict: Verdict, detail: string }}
 */
export function classify(entry, oneShot) {
  if (!entry) return { verdict: 'starting', detail: 'not created yet' };
  const { State, Health, ExitCode } = entry;
  if (oneShot) {
    if (State === 'exited') {
      return ExitCode === 0
        ? { verdict: 'ready', detail: 'completed (exit 0)' }
        : { verdict: 'failed', detail: `exited ${String(ExitCode)}` };
    }
    // A job that stays up after its work (minio-init) signals completion through its healthcheck.
    if (State === 'running' && Health === 'healthy')
      return { verdict: 'ready', detail: 'completed' };
    if (Health === 'unhealthy') return { verdict: 'failed', detail: 'unhealthy' };
    return { verdict: 'starting', detail: State || 'pending' };
  }
  if (State === 'exited' || State === 'dead') {
    return { verdict: 'failed', detail: `${State} (exit ${String(ExitCode)})` };
  }
  if (State === 'running') {
    if (Health === 'healthy') return { verdict: 'ready', detail: 'healthy' };
    if (Health === 'unhealthy') return { verdict: 'failed', detail: 'unhealthy' };
    if (Health === '') return { verdict: 'ready', detail: 'running (no healthcheck)' };
    return { verdict: 'starting', detail: Health };
  }
  return { verdict: 'starting', detail: State || 'pending' };
}

/**
 * @param {ServiceStatus[]} statuses
 * @returns {string}
 */
export function formatTable(statuses) {
  const width = Math.max(MIN_SERVICE_COLUMN, ...statuses.map((s) => s.service.length));
  const mark = { ready: 'ok', starting: '..', failed: 'FAIL' };
  const rows = statuses.map(
    (s) => `  ${s.service.padEnd(width)}  ${mark[s.verdict].padEnd(STAT_COLUMN)}  ${s.detail}`,
  );
  return [`  ${'SERVICE'.padEnd(width)}  STAT  DETAIL`, ...rows].join('\n') + '\n';
}

/**
 * Replaces credential-looking lines and any known secret value, so log tails never leak secrets.
 * @param {string} text
 * @param {string[]} [secrets]
 */
export function redact(text, secrets = []) {
  let out = text
    .split('\n')
    .map((line) =>
      /(password|passwd|secret|token|api[_-]?key|unseal|credential)/i.test(line)
        ? '[redacted line]'
        : line,
    )
    .join('\n');
  for (const s of secrets) if (s.length >= MIN_SECRET_LENGTH) out = out.split(s).join('[redacted]');
  return out;
}

/**
 * Values of the `.env` keys that hold credentials, used to scrub log output.
 * @param {string} envFile
 * @returns {string[]}
 */
export function envSecrets(envFile) {
  if (!existsSync(envFile)) return [];
  /** @type {string[]} */
  const out = [];
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
    if (m?.[1] && m[2] && /(PASSWORD|SECRET|TOKEN|_KEY)$/.test(m[1])) out.push(m[2]);
  }
  return out;
}

/**
 * Polls compose until every service is ready, one fails, or the timeout passes.
 * @param {{
 *   services: string[],
 *   oneShots?: string[],
 *   ps: () => string,
 *   logs?: (service: string) => string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   out?: (s: string) => void,
 * }} opts
 * @returns {Promise<{ ok: boolean, statuses: ServiceStatus[], failed: string[], reason: string }>}
 */
export async function waitForHealth(opts) {
  const oneShots = new Set(opts.oneShots ?? []);
  const all = [
    ...opts.services,
    ...(opts.oneShots ?? []).filter((s) => !opts.services.includes(s)),
  ];
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  const out = opts.out ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const deadline = now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  /** @type {ServiceStatus[]} */
  let statuses = [];
  let last = '';
  for (;;) {
    const entries = parseComposePs(opts.ps());
    statuses = all.map((service) => ({
      service,
      ...classify(
        entries.find((e) => e.Service === service),
        oneShots.has(service),
      ),
    }));
    const table = formatTable(statuses);
    if (table !== last) out(table);
    last = table;
    const failed = statuses.filter((s) => s.verdict === 'failed').map((s) => s.service);
    if (failed.length > 0) return finish(false, failed, `unhealthy: ${failed.join(', ')}`);
    if (statuses.every((s) => s.verdict === 'ready')) return finish(true, [], 'all ready');
    if (now() >= deadline) {
      const pending = statuses.filter((s) => s.verdict !== 'ready').map((s) => s.service);
      return finish(false, pending, `timed out waiting for: ${pending.join(', ')}`);
    }
    await sleep(opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  /**
   * @param {boolean} ok
   * @param {string[]} failed
   * @param {string} reason
   */
  function finish(ok, failed, reason) {
    if (!ok && opts.logs) {
      for (const svc of failed) out(`--- last log lines of ${svc} ---\n${opts.logs(svc)}\n`);
    }
    return { ok, statuses, failed, reason };
  }
}

/**
 * Compose runner for the shared `bwdev` project.
 * @param {string} envFile
 * @returns {Runner}
 */
export function composeRunner(envFile) {
  return (args) => {
    const envArgs = existsSync(envFile) ? ['--env-file', envFile] : [];
    const r = spawnSync(
      'docker',
      ['compose', '-p', PROJECT, ...envArgs, '-f', COMPOSE_FILE, ...args],
      { encoding: 'utf8' },
    );
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

/**
 * `ps` and redacted `logs` callbacks for {@link waitForHealth} on top of a runner.
 * @param {Runner} run
 * @param {string[]} secrets
 */
export function composeProbes(run, secrets) {
  return {
    ps: () => run(['ps', '--all', '--format', 'json']).stdout,
    logs: (/** @type {string} */ svc) => {
      const r = run(['logs', '--no-color', '--tail', String(LOG_TAIL_LINES), svc]);
      return redact(`${r.stdout}${r.stderr}`, secrets);
    },
  };
}

/**
 * @param {string[]} argv
 * @returns {{ timeoutMs: number, services: string[], oneShots: string[] }}
 */
export function parseArgs(argv) {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  /** @type {string[]} */
  const services = [];
  /** @type {string[]} */
  const oneShots = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    if (arg === '--timeout' && next && /^\d+$/.test(next)) {
      timeoutMs = Number(next) * MS_PER_SECOND;
      i += 1;
    } else if (arg === '--one-shot' && next) {
      oneShots.push(next);
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown argument: ${arg}`);
    } else services.push(arg);
  }
  if (services.length === 0 && oneShots.length === 0) throw new Error('no services given');
  return { timeoutMs, services, oneShots };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const envFile = path.join(ROOT, '.env');
    const result = await waitForHealth({
      ...args,
      ...composeProbes(composeRunner(envFile), envSecrets(envFile)),
    });
    if (!result.ok) process.stderr.write(`wait-for-health: ${result.reason}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`wait-for-health: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 2;
  }
}
