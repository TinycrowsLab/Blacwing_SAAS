// Ordered, idempotent bring-up of the dev dependency stack (DEVENV-010, #164). Used by
// `scripts/dev-deps.mjs` (`pnpm dev:deps`, `dev:deps:obs`, `dev:deps:reset`).
//
//   1. preflight: Docker daemon reachable and enough memory/CPU (see docs/runbooks/dev-host-bootstrap.md);
//   2. a host-wide lockfile so two `dev:deps` runs never overlap on the shared `bwdev` project;
//   3. `compose up -d` of the long-running core services, then wait until every one is healthy;
//   4. bootstraps strictly in order, each gated on its own service being healthy:
//      Neo4j constraints -> OpenBao transit -> MinIO buckets -> Temporal namespace -> Keycloak realm.
// Every step converges when re-run (a run killed mid-bootstrap is fixed by running it again), and no
// step prints a credential.

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeProbes, waitForHealth } from './wait-for-health.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OPENBAO_BOOTSTRAP = path.join(ROOT, 'infra/compose/openbao/bootstrap.sh');
export const RESET_HINT =
  'If volumes are left over from an older schema, recreate the stack: pnpm dev:deps:reset --yes';
export const DOCKER_HINT =
  'See docs/runbooks/dev-host-bootstrap.md (DEVENV-001) for Docker setup and resource requirements.';
/** Minimum Docker memory for the core stack (Neo4j 2.5g + Keycloak + Temporal + the rest). */
const GIB = 1_073_741_824;
const MIN_DOCKER_MEMORY_GIB = 6;
export const MIN_DOCKER_MEMORY_BYTES = MIN_DOCKER_MEMORY_GIB * GIB;
const LOCK_FILE_MODE = 0o600;
const GATE_TIMEOUT_MS = 300_000;
const GATE_INTERVAL_MS = 2000;
const REALM_TIMEOUT_MS = 120_000;
const STDERR_TAIL_LINES = 5;
export const MIN_DOCKER_CPUS = 2;

/** Long-running services `pnpm dev:deps` starts first (bootstrap jobs and Keycloak follow in order). */
export const CORE_SERVICES = Object.freeze([
  'postgres',
  'valkey',
  'neo4j',
  'minio',
  'openbao',
  'mailpit',
  'interactsh',
  'temporal',
  'temporal-ui',
]);

/** Bootstrap order (requirement 1). Each entry names the service it needs healthy first. */
export const BOOTSTRAP_ORDER = Object.freeze([
  { name: 'neo4j-constraints', service: 'neo4j', issue: 'DEVENV-002' },
  { name: 'openbao-transit', service: 'openbao', issue: 'DEVENV-005' },
  { name: 'minio-buckets', service: 'minio', issue: 'DEVENV-006' },
  { name: 'temporal-namespace', service: 'temporal', issue: 'DEVENV-007' },
  { name: 'keycloak-realm', service: 'keycloak', issue: 'DEVENV-004' },
]);

// Re-applies the idempotent guard + indexes and proves a node without tenantId is still rejected.
const NEO4J_BOOTSTRAP = [
  'cs() { cypher-shell -a bolt://127.0.0.1:7687 -u neo4j -p "$BW_NEO4J_PASSWORD" "$@"; }',
  'cs -d system -f /bw/bootstrap/tenant-guard.cypher >/dev/null',
  'cs -d neo4j -f /bw/bootstrap/tenant-indexes.cypher >/dev/null',
  'for _ in $(seq 1 30); do',
  '  if out=$(cs -d neo4j "CREATE (n:BwGuardProbe) RETURN n" 2>&1); then',
  '    cs -d neo4j "MATCH (n:BwGuardProbe) DETACH DELETE n" >/dev/null 2>&1 || true',
  '  elif grep -q BW_TENANT_REQUIRED <<<"$out"; then touch /tmp/bw-tenant-guard.ok; exit 0; fi',
  '  sleep 1',
  'done',
  'echo "tenantId guard not verified" >&2; exit 1',
].join('\n');

/**
 * @typedef {import('./wait-for-health.mjs').Runner} Runner
 * @typedef {{
 *   compose: Runner,
 *   docker: Runner,
 *   host: (cmd: string, args: string[]) => number | null,
 *   waitHttp: (url: string, timeoutMs: number) => Promise<void>,
 *   secrets?: string[],
 *   env?: Record<string, string | undefined>,
 *   out?: (s: string) => void,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} Deps
 */

export class DevDepsError extends Error {
  /**
   * @param {string} message
   * @param {string} [hint]
   */
  constructor(message, hint) {
    super(message);
    this.name = 'DevDepsError';
    this.hint = hint ?? '';
  }
}

/**
 * Detects a stopped daemon and an under-provisioned Docker VM before anything starts.
 * @param {Runner} docker
 * @returns {string[]} warnings (resources); throws when Docker is unusable
 */
export function preflight(docker) {
  const r = docker(['info', '--format', '{{json .MemTotal}} {{json .NCPU}}']);
  if (r.status !== 0) {
    throw new DevDepsError(
      'Docker is not running or not reachable (docker info failed). Start Docker and retry.',
      DOCKER_HINT,
    );
  }
  const [mem = 0, cpus = 0] = r.stdout.trim().split(/\s+/).map(Number);
  /** @type {string[]} */
  const warnings = [];
  if (mem > 0 && mem < MIN_DOCKER_MEMORY_BYTES) {
    warnings.push(
      `Docker has ${(mem / GIB).toFixed(1)} GiB memory; the stack needs at least ${String(MIN_DOCKER_MEMORY_GIB)} GiB.`,
    );
  }
  if (cpus > 0 && cpus < MIN_DOCKER_CPUS) {
    warnings.push(
      `Docker has ${String(cpus)} CPU(s); the stack needs at least ${String(MIN_DOCKER_CPUS)}.`,
    );
  }
  return warnings;
}

/** Host-wide: every worktree drives the same `bwdev` project. */
export const DEFAULT_LOCK_FILE = path.join(os.tmpdir(), 'bwdev-dev-deps.lock');

/** @param {number} pid */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {{ code?: string }} */ (error).code === 'EPERM';
  }
}

/**
 * Takes the lock (O_EXCL). A lock held by a live process refuses; a stale one (dead pid) is replaced.
 * @param {string} file
 * @param {{ pid?: number, isAlive?: (pid: number) => boolean }} [opts]
 * @returns {() => void} release
 */
export function acquireLock(file, opts = {}) {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', LOCK_FILE_MODE);
      writeSync(fd, `${String(pid)}\n`);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, 'utf8').trim() === String(pid)) rmSync(file, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code !== 'EEXIST') throw error;
      let holder = Number.NaN;
      try {
        holder = Number(readFileSync(file, 'utf8').trim());
      } catch {
        // vanished between open and read: retry
      }
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
        throw new DevDepsError(
          `another dev:deps run (pid ${String(holder)}) is in progress; wait for it to finish.`,
          `Lockfile: ${file}`,
        );
      }
      rmSync(file, { force: true });
    }
  }
  throw new DevDepsError(`could not take the dev:deps lock ${file}`);
}

/**
 * @param {Deps} deps
 * @param {{ services?: string[], oneShots?: string[], label: string, timeoutMs?: number }} what
 */
async function gate(deps, what) {
  const probes = composeProbes(deps.compose, deps.secrets ?? []);
  const result = await waitForHealth({
    services: what.services ?? [],
    oneShots: what.oneShots ?? [],
    ...probes,
    timeoutMs: what.timeoutMs ?? deps.timeoutMs ?? GATE_TIMEOUT_MS,
    intervalMs: deps.intervalMs ?? GATE_INTERVAL_MS,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.out ? { out: deps.out } : {}),
  });
  if (!result.ok) {
    throw new DevDepsError(`${what.label}: ${result.reason}`, RESET_HINT);
  }
}

/**
 * @param {Deps} deps
 * @param {string[]} args
 * @param {string} label
 */
function composeOk(deps, args, label) {
  const r = deps.compose(args);
  if (r.status !== 0) {
    const tail = r.stderr.trim().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
    throw new DevDepsError(`${label}: docker compose ${args[0] ?? ''} failed\n${tail}`, RESET_HINT);
  }
}

/**
 * The bootstrap steps, in order. Each throws a DevDepsError naming its step and service.
 * @param {Deps} deps
 * @returns {Record<string, () => Promise<void>>}
 */
export function bootstrapSteps(deps) {
  const env = deps.env ?? process.env;
  const keycloakPort = env.BW_DEV_KEYCLOAK_PORT ?? '18080';
  return {
    'neo4j-constraints': () => {
      composeOk(deps, ['exec', '-T', 'neo4j', 'bash', '-c', NEO4J_BOOTSTRAP], 'neo4j-constraints');
      return Promise.resolve();
    },
    'openbao-transit': () => {
      const status = deps.host('bash', [OPENBAO_BOOTSTRAP]);
      if (status !== 0) {
        throw new DevDepsError(
          `openbao-transit: bootstrap exited ${String(status)} (service openbao)`,
          RESET_HINT,
        );
      }
      return Promise.resolve();
    },
    'minio-buckets': async () => {
      composeOk(deps, ['up', '-d', 'minio-init'], 'minio-buckets');
      await gate(deps, { oneShots: ['minio-init'], label: 'minio-buckets' });
    },
    'temporal-namespace': async () => {
      composeOk(deps, ['up', '-d', 'temporal-bootstrap'], 'temporal-namespace');
      await gate(deps, { oneShots: ['temporal-bootstrap'], label: 'temporal-namespace' });
    },
    'keycloak-realm': async () => {
      // keycloak-db (role + DB) runs first via depends_on; `--import-realm` skips an existing realm.
      composeOk(deps, ['up', '-d', 'keycloak'], 'keycloak-realm');
      await gate(deps, {
        services: ['keycloak'],
        oneShots: ['keycloak-db'],
        label: 'keycloak-realm',
      });
      try {
        await deps.waitHttp(
          `http://127.0.0.1:${keycloakPort}/realms/blackwing-dev`,
          REALM_TIMEOUT_MS,
        );
      } catch {
        throw new DevDepsError(
          'keycloak-realm: realm blackwing-dev is not served (service keycloak)',
          RESET_HINT,
        );
      }
    },
  };
}

/**
 * Full ordered bring-up. Returns the list of steps run, in order.
 * @param {Deps} deps
 * @param {{ lockFile?: string, profiles?: string[], extraServices?: string[] }} [opts]
 * @returns {Promise<string[]>}
 */
export async function orchestrateUp(deps, opts = {}) {
  const out = deps.out ?? ((/** @type {string} */ s) => process.stdout.write(s));
  for (const w of preflight(deps.docker)) out(`warning: ${w}\n`);
  const release = acquireLock(opts.lockFile ?? DEFAULT_LOCK_FILE);
  try {
    const profileArgs = (opts.profiles ?? []).flatMap((p) => ['--profile', p]);
    const services = [...CORE_SERVICES, ...(opts.extraServices ?? [])];
    out(`dev:deps: starting ${String(services.length)} services (the first run pulls images)\n`);
    composeOk(deps, [...profileArgs, 'up', '-d', ...services], 'start');
    await gate(deps, { services: [...CORE_SERVICES], label: 'core services' });
    const steps = bootstrapSteps(deps);
    /** @type {string[]} */
    const done = [];
    for (const step of BOOTSTRAP_ORDER) {
      out(`dev:deps: bootstrap ${step.name} (${step.issue})\n`);
      const run = steps[step.name];
      if (!run) throw new DevDepsError(`unknown bootstrap step ${step.name}`);
      await run();
      done.push(step.name);
    }
    out('dev:deps: all dependencies healthy and bootstrapped\n');
    return done;
  } finally {
    release();
  }
}

/**
 * Production dependencies for {@link orchestrateUp}.
 * @param {Runner} compose
 * @param {(url: string, timeoutMs: number) => Promise<void>} waitHttp
 * @param {string[]} secrets
 * @param {Record<string, string | undefined>} env
 * @returns {Deps}
 */
export function realDeps(compose, waitHttp, secrets, env) {
  return {
    compose,
    docker: (args) => {
      const r = spawnSync('docker', args, { encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    host: (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status,
    waitHttp,
    secrets,
    env,
  };
}
