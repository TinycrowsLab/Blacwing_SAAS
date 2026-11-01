#!/usr/bin/env node
// Eval target bootstrap (EVAL-001, #796).
//
//   node scripts/eval-targets.mjs up     # `pnpm eval:targets:up`: all public targets + the synthetic labs
//   node scripts/eval-targets.mjs down   # `pnpm eval:targets:down`: stops the synthetic labs only
//
// Every target is pinned by digest in its `eval/targets/<name>/target.json` (the schema lives in
// packages/contracts/src/eval-target.ts and is checked by its tests). `up` logs each target's digest so a run
// records exactly what it ran against. The public targets are started by the existing `targets` driver
// (scripts/targets.mjs, DEVENV-012); the synthetic labs run from eval/targets/docker-compose.eval.yml in their own
// compose project, so `targets:down` and the dev stack never touch them.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVAL_PROJECT = 'bweval';
export const EVAL_COMPOSE = path.join('eval', 'targets', 'docker-compose.eval.yml');
/** The shared target network: the labs and the public targets sit on it, never on bw-dev. */
export const TARGETS_NETWORK = 'bw-targets';

/**
 * Every `target.json` under `dir`, depth first, sorted (stable output for the log and the tests).
 * @param {string} dir
 * @returns {string[]}
 */
export function manifestFiles(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = path.join(dir, entry);
      if (!statSync(full).isDirectory()) return [];
      const manifest = path.join(full, 'target.json');
      return existsSync(manifest) ? [manifest] : manifestFiles(full);
    });
}

/**
 * @typedef {{ name: string, synthetic: boolean,
 *   source: { kind: string, image?: string, baseImage?: string } }} Manifest
 */

/**
 * One log line per target: its name, whether it is synthetic, and the digest-pinned image it runs.
 * @param {string} file a target.json path
 * @returns {string}
 */
export function describeTarget(file) {
  /** @type {unknown} */
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const manifest = /** @type {Manifest} */ (doc);
  const image =
    manifest.source.kind === 'registry'
      ? manifest.source.image
      : `${manifest.source.baseImage ?? ''} (built locally)`;
  return `${manifest.name} synthetic=${String(manifest.synthetic)} image=${image}`;
}

/**
 * @param {string[]} args
 * @param {{ capture?: boolean }} [opts]
 */
function docker(args, opts = {}) {
  return execFileSync('docker', args, {
    cwd: ROOT,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
}

/** Creates the shared target network when it is missing (the public-target driver creates it too). */
function ensureNetwork() {
  try {
    docker(['network', 'inspect', TARGETS_NETWORK], { capture: true });
  } catch {
    docker(['network', 'create', TARGETS_NETWORK]);
  }
}

/**
 * The `eval_targets_up` gauge, one JSON line on stdout, written once every target is up and health-gated.
 * @param {number} count the number of manifests (targets) brought up
 * @returns {string}
 */
export function upMetricLine(count) {
  return JSON.stringify({ metric: 'eval_targets_up', value: count });
}

/** @param {string[]} argv */
export function main(argv) {
  const [cmd = 'up'] = argv;
  if (cmd !== 'up' && cmd !== 'down') {
    process.stderr.write(`unknown command: ${cmd} (expected up | down)\n`);
    return 2;
  }
  if (cmd === 'down') {
    docker(['compose', '-p', EVAL_PROJECT, '-f', EVAL_COMPOSE, 'down', '--remove-orphans']);
    return 0;
  }
  const files = manifestFiles(path.join(ROOT, 'eval', 'targets'));
  for (const file of files) {
    process.stdout.write(`target ${describeTarget(file)}\n`);
  }
  ensureNetwork();
  // Build and start the labs; `--wait` gates on each lab's healthcheck and fails loudly on a missing digest.
  docker([
    'compose',
    '-p',
    EVAL_PROJECT,
    '-f',
    EVAL_COMPOSE,
    'up',
    '-d',
    '--build',
    '--wait',
    '--wait-timeout',
    '600',
  ]);
  // The public targets: the existing driver health-gates them on loopback (DEVENV-012).
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'targets.mjs'), 'up', '--all'], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  process.stdout.write('eval targets up\n');
  process.stdout.write(`${upMetricLine(files.length)}\n`);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`eval-targets: ${msg}\n`);
    process.exitCode = 1;
  }
}
