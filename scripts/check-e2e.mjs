#!/usr/bin/env node
// Checks the e2e workflow policy (CI-006, #140) in .github/workflows/e2e.yml:
// - triggers: label-gated pull requests (`run-e2e`, incl. the `labeled` event), push to main, a
//   nightly schedule; the job `if` lets every non-PR event through unconditionally;
// - `contents: read` only, no secrets, a hard job timeout, TZ=UTC;
// - the step order reuses the DEVENV scripts: dev:deps -> targets:up -> wait-for-health ->
//   db:migrate -> db:seed (twice, idempotency) -> dev -> test:e2e; never the `obs` profile;
// - the Playwright report and test-results are uploaded on failure;
// - the compose services e2e boots publish ports on 127.0.0.1 only and pin images by digest.
//
// Usage: node scripts/check-e2e.mjs [--root <dir>]

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const WORKFLOW = '.github/workflows/e2e.yml';
export const COMPOSE = 'infra/compose/docker-compose.dev.yml';
export const GATE_LABEL = 'run-e2e';
export const MAX_TIMEOUT_MINUTES = 60;
/** Compose services the e2e suite talks to directly. */
export const E2E_SERVICES = Object.freeze(['postgres', 'keycloak', 'juice-shop']);
/** Commands that must appear, in this order, in the job's `run` steps. */
export const ORDER = Object.freeze([
  'pnpm dev:deps',
  'pnpm targets:up',
  'scripts/wait-for-health.mjs',
  'pnpm db:migrate',
  'pnpm db:seed',
  'pnpm db:seed',
  'pnpm dev ',
  'pnpm test:e2e',
]);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {string} text workflow YAML
 * @returns {string[]} problems
 */
export function checkWorkflow(text) {
  const errors = [];
  if (/\$\{\{\s*secrets\./.test(text)) errors.push(`${WORKFLOW} must not reference secrets`);
  const wf = /** @type {unknown} */ (parse(text));
  if (!isRecord(wf)) return [`${WORKFLOW} is not a mapping`];
  const on = isRecord(wf.on) ? wf.on : {};
  const pr = isRecord(on.pull_request) ? on.pull_request : {};
  const types = Array.isArray(pr.types) ? pr.types : [];
  if (!('pull_request' in on) || !types.includes('labeled')) {
    errors.push('pull_request must trigger, including the `labeled` event');
  }
  const push = isRecord(on.push) ? on.push : {};
  if (!Array.isArray(push.branches) || !push.branches.includes('main')) {
    errors.push('push to main must trigger');
  }
  if (!Array.isArray(on.schedule) || on.schedule.length === 0)
    errors.push('a nightly schedule is required');
  const perms = wf.permissions;
  if (!isRecord(perms) || Object.keys(perms).length !== 1 || perms.contents !== 'read') {
    errors.push('permissions must be exactly `contents: read`');
  }
  const jobs = isRecord(wf.jobs) ? wf.jobs : {};
  const job = isRecord(jobs.e2e) ? jobs.e2e : undefined;
  if (job === undefined) return [...errors, 'job `e2e` is missing'];

  const gate = typeof job.if === 'string' ? job.if : '';
  if (
    !gate.includes("github.event_name != 'pull_request'") ||
    !gate.includes(`contains(github.event.pull_request.labels.*.name, '${GATE_LABEL}')`)
  ) {
    errors.push(
      `job if must gate pull requests on the \`${GATE_LABEL}\` label and pass every other event`,
    );
  }
  const timeout = job['timeout-minutes'];
  if (typeof timeout !== 'number' || timeout <= 0 || timeout > MAX_TIMEOUT_MINUTES) {
    errors.push(`timeout-minutes must be a hard limit of at most ${String(MAX_TIMEOUT_MINUTES)}`);
  }
  if (!isRecord(job.env) || job.env.TZ !== 'UTC') errors.push('job env must set TZ=UTC');

  const steps = Array.isArray(job.steps) ? job.steps.filter((s) => isRecord(s)) : [];
  const runs = steps.map((s) =>
    typeof s.run === 'string' ? `${s.run.replaceAll('\n', ' ')} ` : '',
  );
  if (runs.some((r) => /--profile\s+obs|dev:deps:obs/.test(r))) {
    errors.push('e2e must not start the `obs` profile');
  }
  let from = 0;
  for (const cmd of ORDER) {
    const at = runs.findIndex((r, i) => i >= from && r.includes(cmd));
    if (at < 0) {
      errors.push(`step order: \`${cmd.trim()}\` missing or out of order`);
      break;
    }
    from = at + 1;
  }
  const upload = steps.find(
    (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'),
  );
  const uploadPath = isRecord(upload?.with) ? String(upload.with.path) : '';
  if (
    upload === undefined ||
    !String(upload.if).includes('failure()') ||
    !uploadPath.includes('apps/web/playwright-report') ||
    !uploadPath.includes('apps/web/test-results')
  ) {
    errors.push('the Playwright report and test-results must be uploaded on failure');
  }
  return errors;
}

/**
 * @param {string} text compose YAML
 * @returns {string[]} problems
 */
export function checkCompose(text) {
  const errors = [];
  const doc = /** @type {unknown} */ (parse(text));
  const services = isRecord(doc) && isRecord(doc.services) ? doc.services : {};
  for (const name of E2E_SERVICES) {
    const svc = services[name];
    if (!isRecord(svc)) {
      errors.push(`compose service ${name} is missing`);
      continue;
    }
    if (typeof svc.image === 'string' && !/@sha256:[0-9a-f]{64}$/.test(svc.image)) {
      errors.push(`compose service ${name} must pin its image by digest`);
    }
    for (const port of Array.isArray(svc.ports) ? svc.ports : []) {
      if (!String(port).startsWith('127.0.0.1:')) {
        errors.push(`compose service ${name} publishes ${String(port)} off loopback`);
      }
    }
  }
  return errors;
}

/** @param {string} root @returns {string[]} */
export function checkRepo(root) {
  const errors = [];
  for (const [file, check] of /** @type {const} */ ([
    [WORKFLOW, checkWorkflow],
    [COMPOSE, checkCompose],
  ])) {
    const full = path.join(root, file);
    if (!existsSync(full)) errors.push(`${file} is missing`);
    else errors.push(...check(readFileSync(full, 'utf8')));
  }
  return errors;
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  const i = argv.indexOf('--root');
  const root = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1] ?? '.') : process.cwd();
  const errors = checkRepo(root);
  for (const e of errors) console.error(e);
  if (errors.length === 0) console.log('e2e policy ok');
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
