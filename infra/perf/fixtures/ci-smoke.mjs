#!/usr/bin/env node
// `make -C infra/perf ci-smoke` (PERF-001, #320): proves the harness end to end without the full stack.
//   1. starts the offline target on a random local port with a freshly generated bw_ci_ token;
//   2. runs the smoke profile against it: must exit 0 (checks pass, thresholds evaluated);
//   3. runs the threshold-breach fixture: must exit with k6's threshold code (99);
//   4. fails if the token appears in any k6 output or result file.
// The token is never printed. Requires the k6 binary on PATH (see infra/perf/README.md).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTarget } from './target.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const RESULTS = path.join(ROOT, 'infra', 'perf', 'results');
/** k6's exit code when one or more thresholds are breached. */
export const K6_THRESHOLD_EXIT = 99;
/** Bytes of entropy in the generated token (base64url encoded, never printed). */
const TOKEN_BYTES = 24;

/**
 * Runs one k6 script from the repository root.
 * @param {string} script path relative to the repository root
 * @param {Record<string, string>} env extra environment
 * @returns {Promise<{ code: number | null, output: string }>}
 */
function runK6(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('k6', ['run', script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let output = '';
    /** @param {string} chunk */
    const collect = (chunk) => {
      output += chunk;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      reject(new Error(`cannot start k6 (is it on PATH?): ${err.message}`));
    });
    child.on('close', (code) => {
      resolve({ code, output });
    });
  });
}

/** @returns {string} the result files written so far, concatenated (checked for token leaks) */
function resultText() {
  try {
    return readdirSync(RESULTS)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFileSync(path.join(RESULTS, name), 'utf8'))
      .join('\n');
  } catch {
    return '';
  }
}

async function main() {
  const token = `bw_ci_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  const server = createTarget({ token });
  await new Promise((/** @type {(value: void) => void} */ resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('target did not bind a port');
  const env = {
    PERF_BASE_URL: `http://127.0.0.1:${address.port}`,
    PERF_TOKEN: token,
    PERF_PROFILE: 'smoke',
  };

  const failures = [];
  try {
    const smoke = await runK6('infra/perf/k6/baseline.js', env);
    if (smoke.code !== 0) failures.push(`smoke profile exited ${smoke.code}, expected 0`);

    const breach = await runK6('infra/perf/fixtures/threshold-breach.js', env);
    if (breach.code !== K6_THRESHOLD_EXIT) {
      failures.push(`threshold-breach exited ${breach.code}, expected ${K6_THRESHOLD_EXIT}`);
    }

    const leaked = [smoke.output, breach.output, resultText()].some((text) => text.includes(token));
    if (leaked) failures.push('the bearer token leaked into k6 output or a result file');

    process.stdout.write(`smoke exit ${smoke.code}; threshold-breach exit ${breach.code}\n`);
  } finally {
    server.close();
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`ci-smoke: ${failure}\n`);
    process.exitCode = 1;
  }
}

await main();
