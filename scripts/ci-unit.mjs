#!/usr/bin/env node
// Runs the CI unit-test job locally and in GitHub Actions (CI-003, #137): `pnpm test:ci`.
//   1. node scripts/check-test-hygiene.mjs   (no .only / unlinked skips)
//   2. turbo run test -- --coverage ...       (Vitest with v8 coverage + JUnit in every member)
//   2b. the strict-typefixtures suite, un-instrumented (see runTypefixtures)
//   3. fails on obsolete snapshots            (Vitest only reports them; CI must not)
//   4. node scripts/unit-report.mjs           (coverage floors, skip/fail counts, step summary)
//
// Determinism: TZ=UTC and a fixed fast-check seed (BW_FC_SEED, default below) are set for every
// run; the Vitest setup file packages/testing/src/vitest/ci-preload.mjs (a NODE_OPTIONS --import) applies them inside workers.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_FC_SEED = '20240101';
export const TYPEFIXTURES_TEST = '**/typefixtures.test.ts';
// Vitest's summary lines: "Snapshots  2 obsolete" and "1 snapshot file obsolete". A count is required so
// test names and prose that merely mention obsolete snapshots do not match.
export const OBSOLETE_SNAPSHOT =
  /\bsnapshots?\s+(?:[\w-]+\s+)*?\d+ obsolete|\b\d+ snapshot files? obsolete/i;
// eslint-disable-next-line no-control-regex -- strips ANSI colour codes from piped Vitest output
const ANSI = /\u001b\[[0-9;]*m/g;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Node preload that pins TZ and the fast-check seed inside every Vitest worker. */
const PRELOAD = path.join(root, 'packages/testing/src/vitest/ci-preload.mjs');

/**
 * @param {string} output combined test output
 * @returns {boolean} true when Vitest reported obsolete snapshots
 */
export function hasObsoleteSnapshots(output) {
  return output.split('\n').some((line) => OBSOLETE_SNAPSHOT.test(line.replace(ANSI, '')));
}

/**
 * Vitest arguments appended after `--` so Turborepo hands them to every member's `vitest run`.
 * @returns {string[]}
 */
export function vitestArgs() {
  return [
    '--coverage.enabled=true',
    '--coverage.provider=v8',
    '--coverage.reporter=json-summary',
    '--coverage.reporter=lcov',
    '--coverage.reporter=text-summary',
    '--coverage.include=src/**/*.{ts,tsx}',
    '--coverage.exclude=**/*.test.{ts,tsx}',
    '--coverage.exclude=**/*.d.ts',
    '--coverage.exclude=src/vitest*.config.ts',
    '--coverage.exclude=src/testdata/**',
    // v8 instrumentation and parallel members slow timing-sensitive tests; the budget is a ceiling, not a target.
    '--testTimeout=60000',
    // Runs the TypeScript compiler in-process; under v8 coverage that blocks the worker past Vitest's
    // fixed 60 s worker RPC timeout. It measures tooling, not product code, so it runs un-instrumented
    // in its own step (runTypefixtures) with the same pass/fail weight.
    `--exclude=${TYPEFIXTURES_TEST}`,
    '--reporter=default',
    '--reporter=junit',
    '--outputFile.junit=coverage/junit.xml',
  ];
}

/** @returns {Promise<{ code: number, output: string }>} */
function runTurbo() {
  return new Promise((resolve) => {
    const child = spawn(
      'pnpm',
      [
        'exec',
        'turbo',
        'run',
        'test',
        '--continue=always',
        '--concurrency=4',
        '--',
        ...vitestArgs(),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          TZ: 'UTC',
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(PRELOAD).href}`.trim(),
          BW_FC_SEED: process.env.BW_FC_SEED ?? DEFAULT_FC_SEED,
          CI: process.env.CI ?? 'true',
        },
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    );
    let output = '';
    /** @param {NodeJS.WriteStream} sink */
    const tee = (sink) => (/** @type {Buffer} */ chunk) => {
      output += chunk.toString();
      sink.write(chunk);
    };
    child.stdout.on('data', tee(process.stdout));
    child.stderr.on('data', tee(process.stderr));
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

/**
 * @param {string} script
 * @returns {number} exit code
 */
function runNode(script) {
  return (
    spawnSync('node', [path.join(root, 'scripts', script)], { cwd: root, stdio: 'inherit' })
      .status ?? 1
  );
}

/** @returns {number} exit code of the un-instrumented strict-typefixtures suite */
function runTypefixtures() {
  return (
    spawnSync(
      'pnpm',
      [
        '--filter',
        '@blackwing/testing',
        'exec',
        'vitest',
        'run',
        '--config',
        'src/vitest.config.ts',
        'src/typefixtures.test.ts',
        '--testTimeout=120000',
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          TZ: 'UTC',
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(PRELOAD).href}`.trim(),
          BW_FC_SEED: process.env.BW_FC_SEED ?? DEFAULT_FC_SEED,
        },
      },
    ).status ?? 1
  );
}

async function main() {
  if (runNode('check-test-hygiene.mjs') !== 0) return 1;
  const { code, output } = await runTurbo();
  if (code !== 0) {
    console.error('::error::unit tests failed');
    runNode('unit-report.mjs');
    return code;
  }
  if (hasObsoleteSnapshots(output)) {
    console.error('::error::obsolete snapshots found; delete them (vitest -u) and commit');
    return 1;
  }
  if (runTypefixtures() !== 0) {
    console.error('::error::strict typefixtures suite failed');
    return 1;
  }
  return runNode('unit-report.mjs');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
