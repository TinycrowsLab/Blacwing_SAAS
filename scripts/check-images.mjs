#!/usr/bin/env node
// Guards the container image matrix (CI-007, #141):
// - the build-images workflow matrix lists exactly the nine long-running services, and never
//   `bw-sandbox` (owned solely by IMAGE-012, gated and signed);
// - the registry is only ever ghcr.io/tinycrowslab/bw-<service> (never `blackwing-<service>`);
// - every `FROM` in a matrix Dockerfile pins its base image by sha256 digest (§8.9) and the final
//   stage does not run as root; no `:latest`-only tag is pushed;
// - pull requests never push, and the push gate cannot be reached from a pull request.
//
// Usage: node scripts/check-images.mjs [--root <dir>]

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const WORKFLOW = '.github/workflows/build-images.yml';
export const SERVICES = [
  'api',
  'web',
  'worker',
  'agent-runtime',
  'model-gateway',
  'egress-gateway',
  'session-manager',
  'sandbox-controller',
  'cli',
];
export const REGISTRY = 'ghcr.io/tinycrowslab';

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks the workflow text.
 * @param {string} text workflow YAML
 * @returns {{ errors: string[], files: string[] }} problems and the Dockerfiles it builds
 */
export function checkWorkflow(text) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const files = [];
  /** @type {unknown} */
  let doc;
  try {
    doc = parse(text);
  } catch (e) {
    return { errors: [`${WORKFLOW}: invalid YAML (${String(e)})`], files };
  }
  const jobs = isRecord(doc) && isRecord(doc.jobs) ? doc.jobs : {};
  const build = jobs.build;
  const strategy = isRecord(build) ? build.strategy : undefined;
  const matrix = isRecord(strategy) ? strategy.matrix : undefined;
  const include = isRecord(matrix) && Array.isArray(matrix.include) ? matrix.include : [];
  const listed = include.flatMap((e) =>
    isRecord(e) && typeof e.service === 'string' ? [e.service] : [],
  );
  for (const e of include) {
    if (isRecord(e) && typeof e.file === 'string') files.push(e.file);
  }
  if (/bw-sandbox(?!-controller)|\bsandbox\b(?!-controller)/.test(JSON.stringify(include))) {
    errors.push(`${WORKFLOW}: bw-sandbox must not be in the image matrix (IMAGE-012 owns it)`);
  }
  for (const s of SERVICES) {
    if (!listed.includes(s)) errors.push(`${WORKFLOW}: matrix is missing service "${s}"`);
  }
  for (const s of listed) {
    if (!SERVICES.includes(s)) errors.push(`${WORKFLOW}: unexpected matrix service "${s}"`);
  }
  if (new Set(listed).size !== listed.length) errors.push(`${WORKFLOW}: duplicate matrix service`);
  /** @type {unknown} */
  const egress = include.find((e) => isRecord(e) && e.service === 'egress-gateway');
  const platforms = isRecord(egress) ? String(egress.platforms) : '';
  if (!platforms.includes('linux/amd64') || !platforms.includes('linux/arm64')) {
    errors.push(`${WORKFLOW}: egress-gateway must build linux/amd64 and linux/arm64`);
  }
  if (isRecord(strategy) && strategy['fail-fast'] !== false) {
    errors.push(`${WORKFLOW}: build matrix must set fail-fast: false`);
  }
  if (text.replace(/Blackwing/g, '').includes('blackwing-')) {
    errors.push(
      `${WORKFLOW}: registry path must be ghcr.io/tinycrowslab/bw-<service>, never blackwing-*`,
    );
  }
  if (!text.includes(`REGISTRY: ${REGISTRY}`)) {
    errors.push(`${WORKFLOW}: REGISTRY must be ${REGISTRY}`);
  }
  if (/:latest\b/.test(text) || text.includes('type=raw,value=latest')) {
    errors.push(`${WORKFLOW}: floating "latest" tags are forbidden; record digests`);
  }
  if (!/PUSH:.*github\.event_name != 'pull_request'/.test(text)) {
    errors.push(`${WORKFLOW}: PUSH must be false for pull_request events`);
  }
  if (text.includes('pull_request_target')) {
    errors.push(`${WORKFLOW}: pull_request_target would expose the push token to forks`);
  }
  return { errors, files };
}

/**
 * Checks one Dockerfile.
 * @param {string} file repo-relative path
 * @param {string} text contents
 * @returns {string[]} problems
 */
export function checkDockerfile(file, text) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, string>} */
  const args = new Map();
  /** @type {string[]} */
  const stages = [];
  let user = '';
  for (const raw of text.replace(/\\\n/g, ' ').split('\n')) {
    const line = raw.trim();
    const arg = /^ARG\s+(\w+)=(\S+)/.exec(line);
    if (arg?.[1] !== undefined && arg[2] !== undefined) args.set(arg[1], arg[2]);
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from?.[1] !== undefined) {
      const ref = from[1];
      const alias = from[2];
      if (stages.includes(ref)) {
        user = '';
      } else {
        const resolved = ref.replace(/\$\{(\w+)\}/g, (_m, name) => args.get(String(name)) ?? '');
        const inline = ref.replace(/\$\{\w+\}/g, '');
        if (!/@sha256:[0-9a-f]{64}$/.test(resolved) && !/@sha256:[0-9a-f]{64}/.test(inline)) {
          errors.push(`${file}: base image "${ref}" is not pinned by sha256 digest`);
        }
        user = '';
      }
      if (alias !== undefined) stages.push(alias);
    }
    const u = /^USER\s+(\S+)/i.exec(line);
    if (u?.[1] !== undefined) user = u[1];
  }
  if (user === '' || /^(root|0)(:|$)/.test(user)) {
    errors.push(`${file}: final stage must set a non-root USER`);
  }
  return errors;
}

/**
 * @param {string} root repository root
 * @returns {string[]} problems
 */
export function checkRepo(root) {
  const wf = path.join(root, WORKFLOW);
  if (!existsSync(wf)) return [`${WORKFLOW}: missing`];
  const { errors, files } = checkWorkflow(readFileSync(wf, 'utf8'));
  for (const f of new Set(files)) {
    const p = path.join(root, f);
    if (!existsSync(p)) errors.push(`${f}: Dockerfile missing`);
    else errors.push(...checkDockerfile(f, readFileSync(p, 'utf8')));
  }
  return errors;
}

/** @param {string[]} argv */
export function main(argv) {
  const i = argv.indexOf('--root');
  const root =
    i >= 0 && argv[i + 1] !== undefined
      ? path.resolve(argv[i + 1] ?? '')
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkRepo(root);
  for (const e of errors) process.stderr.write(`check-images: ${e}\n`);
  if (errors.length === 0) process.stdout.write('check-images: ok\n');
  return errors.length === 0 ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
