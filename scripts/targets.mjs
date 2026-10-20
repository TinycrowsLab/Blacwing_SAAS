#!/usr/bin/env node
// Local vulnerable-target driver (DEVENV-012, #166).
//
//   node scripts/targets.mjs up [service...|--all] [--tls]  # `pnpm targets:up`: default juice-shop only
//   node scripts/targets.mjs smoke                   # `pnpm targets:smoke`: live up + reachability + isolation check
//   node scripts/targets.mjs down                    # `pnpm targets:down`: stops/removes targets only
//   node scripts/targets.mjs reset <service>         # recreate one target with fresh state
//   node scripts/targets.mjs wait [service...]       # wait until the targets answer on loopback
//   node scripts/targets.mjs config                  # validate/render the `targets` profile
//
// The targets are deliberately-vulnerable TRAINING apps on the isolated `bw-targets` network, published
// on 127.0.0.1 only. `down` NEVER runs `compose down`: the project `bwdev` is shared with the dev
// dependency stack (postgres, valkey, neo4j) and other worktrees, so only target containers are touched.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPOSE_FILE, PROJECT, ensureEnv, parseEnv } from './dev-deps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TARGETS_NETWORK = 'bw-targets';
const REQUEST_TIMEOUT_MS = 5000;
const PROBE_INTERVAL_MS = 2000;
const UP_WAIT_MS = 60_000;
const HTTP_SERVER_ERROR = 500;
export const DEFAULT_SERVICES = Object.freeze(['juice-shop']);
export const DEV_NETWORK = 'bw-dev';
/** Service of the bw-targets-only TLS edge (profile `targets-tls`): serves https://juice.bw.localhost. */
export const TLS_EDGE_SERVICE = 'traefik-targets';

/**
 * Per target: compose service, the asset type it represents, host port (overridable) and the
 * loopback readiness probe path. `sidecars` are the extra services a target needs.
 * @type {ReadonlyArray<{ service: string, asset: string, host: string, port: number,
 *   portEnv: string, probe: string, sidecars: readonly string[] }>}
 */
export const TARGETS = Object.freeze([
  {
    service: 'juice-shop',
    asset: 'web_app',
    host: 'juice.bw.localhost',
    port: 13000,
    portEnv: 'BW_TARGET_JUICE_SHOP_PORT',
    probe: '/rest/admin/application-version',
    sidecars: [],
  },
  {
    service: 'crapi',
    asset: 'api',
    host: 'crapi.bw.localhost',
    port: 13010,
    portEnv: 'BW_TARGET_CRAPI_PORT',
    probe: '/',
    sidecars: [
      'crapi-postgres',
      'crapi-mongo',
      'crapi-mailhog',
      'crapi-identity',
      'crapi-community',
      'crapi-workshop',
      'crapi-chatbot',
    ],
  },
  {
    service: 'vampi',
    asset: 'api',
    host: 'vampi.bw.localhost',
    port: 13020,
    portEnv: 'BW_TARGET_VAMPI_PORT',
    probe: '/',
    sidecars: [],
  },
  {
    service: 'dvga',
    asset: 'graphql',
    host: 'dvga.bw.localhost',
    port: 13030,
    portEnv: 'BW_TARGET_DVGA_PORT',
    probe: '/',
    sidecars: [],
  },
  {
    service: 'dvwa',
    asset: 'web_app',
    host: 'dvwa.bw.localhost',
    port: 13040,
    portEnv: 'BW_TARGET_DVWA_PORT',
    probe: '/login.php',
    sidecars: [],
  },
  {
    service: 'webgoat',
    asset: 'web_app',
    host: 'webgoat.bw.localhost',
    port: 13050,
    portEnv: 'BW_TARGET_WEBGOAT_PORT',
    probe: '/WebGoat/login',
    sidecars: [],
  },
]);

/** Every service of the profile (targets and sidecars). */
export const ALL_SERVICES = Object.freeze(TARGETS.flatMap((t) => [t.service, ...t.sidecars]));

/**
 * Resolves CLI service names to compose services; unknown names throw (fail closed).
 * @param {string[]} names
 * @returns {string[]} target services requested (defaults to Juice Shop only)
 */
export function selectTargets(names) {
  if (names.includes('--all')) return TARGETS.map((t) => t.service);
  if (names.length === 0) return [...DEFAULT_SERVICES];
  const known = new Set(TARGETS.map((t) => t.service));
  for (const n of names) {
    if (!known.has(n)) {
      throw new Error(`unknown target: ${n} (expected ${[...known].join(' | ')} | --all)`);
    }
  }
  return names;
}

/**
 * The environment compose resolves `${BW_TARGET_*}` from: the `.env` file, overridden by the shell
 * (compose precedence). Reading it the same way keeps probes on the port compose published.
 * @param {string} envFile
 * @param {Record<string, string | undefined>} [shell]
 * @returns {Record<string, string | undefined>}
 */
export function resolveEnv(envFile, shell = process.env) {
  const file = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  return { ...file, ...shell };
}

/**
 * Loopback URL of a target, honouring the port override (pass `resolveEnv(...)` so `.env` counts).
 * @param {string} service
 * @param {Record<string, string | undefined>} [env]
 */
export function targetUrl(service, env = process.env) {
  const t = TARGETS.find((x) => x.service === service);
  if (!t) throw new Error(`unknown target: ${service}`);
  return `http://127.0.0.1:${env[t.portEnv] ?? String(t.port)}`;
}

/**
 * @param {string[]} args
 * @param {{ envFile: string, capture?: boolean, tls?: boolean }} opts
 */
function compose(args, opts) {
  const extra = opts.tls ? ['--profile', 'targets-tls'] : [];
  return execFileSync(
    'docker',
    [
      'compose',
      '-p',
      PROJECT,
      '--env-file',
      opts.envFile,
      '-f',
      COMPOSE_FILE,
      '--profile',
      'targets',
      ...extra,
      ...args,
    ],
    { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' },
  );
}

/**
 * The networks of a `docker inspect` document (sorted names).
 * @param {unknown} inspected parsed `docker inspect` JSON (array of one container)
 * @returns {string[]}
 */
export function networksOf(inspected) {
  const doc = /** @type {Array<{ NetworkSettings?: { Networks?: Record<string, unknown> } }>} */ (
    inspected
  );
  return Object.keys(doc[0]?.NetworkSettings?.Networks ?? {}).sort();
}

/**
 * Throws unless the container is on exactly the bw-targets network (and not bw-dev).
 * @param {string[]} networks
 */
export function assertIsolated(networks) {
  if (networks.includes(DEV_NETWORK) || networks.join() !== TARGETS_NETWORK) {
    throw new Error(
      `juice-shop networks must be exactly [${TARGETS_NETWORK}], got [${networks.join(', ')}]`,
    );
  }
}

/**
 * Polls the loopback URL of each target until it answers (any HTTP status below 500).
 * @param {string[]} services
 * @param {number} [timeoutMs]
 * @param {Record<string, string | undefined>} [env] resolved env (`.env` + shell)
 */
export async function waitReachable(services, timeoutMs = 300_000, env = process.env) {
  const deadline = Date.now() + timeoutMs;
  for (const svc of services) {
    const t = TARGETS.find((x) => x.service === svc);
    if (!t) throw new Error(`unknown target: ${svc}`);
    const url = `${targetUrl(svc, env)}${t.probe}`;
    for (;;) {
      try {
        const res = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status < HTTP_SERVER_ERROR) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`${svc} not reachable at ${url}`);
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
    }
    process.stdout.write(`${svc}: reachable at ${targetUrl(svc, env)}\n`);
  }
}

/**
 * Live smoke: brings Juice Shop up, asserts it answers on BW_TARGET_JUICE_SHOP_URL (the e2e and seed
 * contract) and that its container is on exactly [bw-targets], not bw-dev.
 * @param {string} envFile
 * @param {Record<string, string | undefined>} env
 */
async function smoke(envFile, env) {
  compose(['up', '-d', '--wait', '--wait-timeout', '600', 'juice-shop'], { envFile });
  await waitReachable(['juice-shop'], UP_WAIT_MS, env);
  const url = env.BW_TARGET_JUICE_SHOP_URL ?? targetUrl('juice-shop', env);
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status >= HTTP_SERVER_ERROR)
    throw new Error(`juice-shop answered ${res.status} at ${url}`);
  const id = compose(['ps', '-q', 'juice-shop'], { envFile, capture: true }).trim();
  if (id === '') throw new Error('juice-shop container not found');
  /** @type {unknown} */
  const inspected = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }));
  const networks = networksOf(inspected);
  assertIsolated(networks);
  process.stdout.write(
    `smoke ok: juice-shop answers ${String(res.status)} at ${url}; networks=[${networks.join(', ')}]\n`,
  );
  return 0;
}

/** @param {string[]} argv */
export async function main(argv) {
  const [cmd = 'up', ...rest] = argv;
  const envFile = path.join(ROOT, '.env');
  ensureEnv(envFile);
  if (cmd === 'config') {
    compose(['config', '--quiet'], { envFile });
    return 0;
  }
  const env = resolveEnv(envFile);
  if (cmd === 'up') {
    const tls = rest.includes('--tls');
    const services = selectTargets(rest.filter((a) => a !== '--tls'));
    const all = tls ? [...services, TLS_EDGE_SERVICE] : services;
    compose(['up', '-d', '--wait', '--wait-timeout', '600', ...all], { envFile, tls });
    await waitReachable(services, UP_WAIT_MS, env);
    return 0;
  }
  if (cmd === 'wait') {
    await waitReachable(selectTargets(rest), undefined, env);
    return 0;
  }
  if (cmd === 'smoke') return smoke(envFile, env);
  if (cmd === 'down') {
    // Only the profile's services: never `compose down` on the shared bwdev project.
    compose(['rm', '-sfv', ...ALL_SERVICES, TLS_EDGE_SERVICE], { envFile, tls: true });
    try {
      execFileSync('docker', ['network', 'rm', TARGETS_NETWORK], { stdio: 'ignore' });
    } catch {
      // network still in use by someone else's containers, or already gone: leave it
    }
    return 0;
  }
  if (cmd === 'reset') {
    const services = selectTargets(rest);
    if (rest.length === 0) {
      process.stderr.write('targets:reset needs a target name, e.g. pnpm targets:reset dvwa\n');
      return 2;
    }
    const t = TARGETS.filter((x) => services.includes(x.service));
    compose(['rm', '-sfv', ...t.flatMap((x) => [x.service, ...x.sidecars])], { envFile });
    compose(['up', '-d', '--wait', '--wait-timeout', '600', ...services], { envFile });
    return 0;
  }
  process.stderr.write(
    `unknown command: ${cmd} (expected up | down | reset | wait | smoke | config)\n`,
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (/** @type {unknown} */ error) => {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`targets: ${msg}\n`);
      process.exitCode = 1;
    },
  );
}
