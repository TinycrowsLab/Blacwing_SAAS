#!/usr/bin/env node
// Guards the integration-test CI job (CI-004, #138):
// - infra/images.lock is the single image manifest: every entry is digest-pinned (§8.9) and equals
//   the Testcontainers pin (packages/testing/src/containers/images.ts) and the dev compose image,
//   so CI == dev;
// - the `integration` job in .github/workflows/test.yml runs `pnpm test:int` with read-only
//   permissions, a timeout, no secrets, container reuse disabled, the pull-with-retry step driven
//   by the manifest, and JUnit + container logs uploaded on failure;
// - the mandatory cross-tenant denial test (§8.6) exists in the Postgres integration suite.
//
// Usage: node scripts/check-integration.mjs [--root <dir>]
// Exits non-zero (listing every problem) when the policy is not met.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const LOCK = 'infra/images.lock';
export const TEST_WORKFLOW = '.github/workflows/test.yml';
export const IMAGES_TS = 'packages/testing/src/containers/images.ts';
export const COMPOSE = 'infra/compose/docker-compose.dev.yml';
export const ISOLATION_TEST = 'packages/testing/src/containers/postgres.int.test.ts';
export const SERVICES = Object.freeze(['postgres', 'valkey', 'neo4j', 'minio']);
const DIGEST_PIN = /^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$/;

/**
 * @param {string} text contents of images.lock
 * @returns {Record<string, string>} service name to image reference
 */
export function parseLock(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * @param {string} root repository root
 * @param {string} file repo-relative path
 * @returns {string | null}
 */
const read = (root, file) =>
  existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : null;

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>} the value when it is a plain object, else an empty object
 */
/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string} the value when it is a string, else the fallback
 */
const str = (value, fallback) => (typeof value === 'string' ? value : fallback);

const rec = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};

/**
 * @param {string} text workflow text
 * @param {string} [ciScript] the root package.json `test:int:ci` script
 * @returns {string[]} problems found in the integration job
 */
export function checkWorkflow(text, ciScript = '') {
  /** @type {string[]} */
  const problems = [];
  const wf = rec(parse(text));
  const job = rec(rec(wf.jobs).integration);
  if (Object.keys(job).length === 0) return ['test.yml: no "integration" job'];
  const steps = Array.isArray(job.steps) ? job.steps.map((st) => rec(st)) : [];
  const runs = steps.map((s) => str(s.run, '')).join('\n');
  const perms = { ...rec(wf.permissions), ...rec(job.permissions) };
  if (!/\bpnpm test:int(:ci)?\b/.test(runs))
    problems.push('integration job does not run `pnpm test:int`');
  if (perms.contents !== 'read') problems.push('integration job must have `contents: read`');
  if (Object.entries(perms).some(([k, v]) => k !== 'contents' && v !== 'none'))
    problems.push('integration job must not request permissions beyond contents: read');
  if (typeof job['timeout-minutes'] !== 'number')
    problems.push('integration job needs timeout-minutes');
  if (!runs.includes('images.lock'))
    problems.push('integration job must pre-pull images listed in infra/images.lock');
  if (!/attempt/i.test(runs)) problems.push('integration job pull step must retry');
  for (const e of [rec(wf.env), rec(job.env)]) {
    for (const key of ['TESTCONTAINERS_REUSE_ENABLE', 'BW_TESTCONTAINERS_REUSE']) {
      if (e[key] === true || str(e[key], 'false') === 'true')
        problems.push(`integration job must not enable Testcontainers reuse (${key})`);
    }
  }
  if (/\$\{\{\s*secrets\./.test(JSON.stringify(job)))
    problems.push('integration job must not use secrets');
  const upload = steps.find((st) => str(st.uses, '').startsWith('actions/upload-artifact@'));
  if (upload === undefined) problems.push('integration job must upload JUnit/log artifacts');
  else if (!/failure\(\)|always\(\)|!cancelled\(\)/.test(str(upload.if, '')))
    problems.push('integration artifact upload must run when tests fail');
  if (!(runs + ciScript).includes('junit')) problems.push('integration job must emit JUnit output');
  if (/\bpnpm test:int:ci\b/.test(runs) && !ciScript.includes('turbo run test:int'))
    problems.push('package.json test:int:ci must wrap `turbo run test:int`');
  if (!/docker (ps|logs)/.test(runs))
    problems.push('integration job must surface container logs on failure');
  if (!steps.some((st) => str(st.uses, '').includes('.github/actions/setup')))
    problems.push('integration job must use the setup composite action');
  return problems;
}

/**
 * @param {string} root repository root
 * @returns {string[]} problems found
 */
export function check(root) {
  /** @type {string[]} */
  const problems = [];
  const lockText = read(root, LOCK);
  if (lockText === null) return [`${LOCK} is missing`];
  const lock = parseLock(lockText);
  const imagesTs = read(root, IMAGES_TS) ?? '';
  const compose = read(root, COMPOSE) ?? '';
  for (const name of SERVICES) {
    const ref = lock[name];
    if (ref === undefined) {
      problems.push(`${LOCK}: no entry for ${name}`);
      continue;
    }
    if (!DIGEST_PIN.test(ref)) problems.push(`${LOCK}: ${name} is not pinned by sha256 digest`);
    if (!imagesTs.includes(`'${ref}'`))
      problems.push(`${IMAGES_TS}: ${name} does not match ${LOCK} (${ref})`);
    if (!compose.includes(ref)) problems.push(`${COMPOSE}: ${name} does not use ${LOCK} (${ref})`);
  }
  const wfText = read(root, TEST_WORKFLOW);
  if (wfText === null) problems.push(`${TEST_WORKFLOW} is missing`);
  else {
    const pkg = rec(JSON.parse(read(root, 'package.json') ?? '{}'));
    problems.push(...checkWorkflow(wfText, str(rec(pkg.scripts)['test:int:ci'], '')));
  }
  const iso = read(root, ISOLATION_TEST);
  if (!iso?.includes('crossTenantDenied'))
    problems.push(`${ISOLATION_TEST}: cross-tenant denial test (§8.6) is missing`);
  return problems;
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const i = argv.indexOf('--root');
  const root =
    i >= 0
      ? path.resolve(argv[i + 1] ?? '.')
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const problems = check(root);
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-integration: ${p}`);
    return 1;
  }
  console.log('check-integration: ok');
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
