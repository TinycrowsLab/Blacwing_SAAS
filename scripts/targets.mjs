#!/usr/bin/env node
// Local vulnerable-target driver (DEVENV-012, #166).
//
//   node scripts/targets.mjs up [service...|--all]   # `pnpm targets:up`: default juice-shop only
//   node scripts/targets.mjs down                    # `pnpm targets:down`: stops/removes targets only
//   node scripts/targets.mjs reset <service>         # recreate one target with fresh state
//   node scripts/targets.mjs wait [service...]       # wait until the targets answer on loopback
//   node scripts/targets.mjs config                  # validate/render the `targets` profile
//
// The targets are deliberately-vulnerable TRAINING apps on the isolated `bw-targets` network, published
// on 127.0.0.1 only. `down` NEVER runs `compose down`: the project `bwdev` is shared with the dev
// dependency stack (postgres, valkey, neo4j) and other worktrees, so only target containers are touched.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPOSE_FILE, PROJECT, ensureEnv } from './dev-deps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TARGETS_NETWORK = 'bw-targets';
const REQUEST_TIMEOUT_MS = 5000;
const PROBE_INTERVAL_MS = 2000;
const UP_WAIT_MS = 60_000;
const HTTP_SERVER_ERROR = 500;
export const DEFAULT_SERVICES = Object.freeze(['juice-shop']);

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
 * Loopback URL of a target, honouring the port override.
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
 * @param {{ envFile: string, capture?: boolean }} opts
 */
function compose(args, opts) {
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
      ...args,
    ],
    { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' },
  );
}

/**
 * Polls the loopback URL of each target until it answers (any HTTP status below 500).
 * @param {string[]} services
 * @param {number} [timeoutMs]
 */
export async function waitReachable(services, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (const svc of services) {
    const t = TARGETS.find((x) => x.service === svc);
    if (!t) throw new Error(`unknown target: ${svc}`);
    const url = `${targetUrl(svc)}${t.probe}`;
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
    process.stdout.write(`${svc}: reachable at ${targetUrl(svc)}\n`);
  }
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
  if (cmd === 'up') {
    const services = selectTargets(rest);
    compose(['up', '-d', '--wait', '--wait-timeout', '600', ...services], { envFile });
    await waitReachable(services, UP_WAIT_MS);
    return 0;
  }
  if (cmd === 'wait') {
    await waitReachable(selectTargets(rest));
    return 0;
  }
  if (cmd === 'down') {
    // Only the profile's services: never `compose down` on the shared bwdev project.
    compose(['rm', '-sfv', ...ALL_SERVICES], { envFile });
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
  process.stderr.write(`unknown command: ${cmd} (expected up | down | reset | wait | config)\n`);
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
