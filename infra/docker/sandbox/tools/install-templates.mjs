#!/usr/bin/env node
// Build-time installer for the vendored nuclei-templates (IMAGE-004, #602). Runs once in the image's `tools` stage:
// `node install-templates.mjs <tools.pin.json> <dest-dir>`. The archive of the pinned commit is fetched over HTTPS and
// checked against its sha256 before anything is unpacked. Only the pinned `keep` directories survive, minus the pinned
// `exclude` paths (the non-safe categories). The kept tree must then match the pinned `treeSha256`, a sha256 over a
// sorted manifest of every kept file, so a changed or re-tagged upstream cannot slip in. Symlinks and special files
// fail the build. Node built-ins and install-tools.mjs only; no npm install.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchVerified } from './install-tools.mjs';

const EX_USAGE = 64;
export const TEMPLATE_NAME = 'nuclei-templates';
export const UPSTREAM_REPO = 'https://github.com/projectdiscovery/nuclei-templates';
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const PIN_FILE_NAME = '.bw-template-pin.json';
const TAR_TIMEOUT_MS = 600_000;

/**
 * @typedef {{
 *   name: string, version: string, repo: string, commit: string, url: string, sha256: string,
 *   treeSha256: string, licence: string, keep: string[], exclude: string[]
 * }} PinnedTemplates
 */

/**
 * A relative path made of plain segments only: no empty, dot or parent segments and no absolute prefix.
 * @param {string} rel
 */
export function safeRel(rel) {
  return rel.split('/').every((s) => SEGMENT.test(s));
}

/**
 * Narrows the pinned template entry and fails closed on anything malformed or inconsistent.
 * @param {unknown} pins parsed tools.pin.json
 * @returns {PinnedTemplates}
 */
export function templatesPin(pins) {
  const list = /** @type {{ templates?: unknown } | null} */ (pins)?.templates;
  const entries = Array.isArray(list) ? /** @type {unknown[]} */ (list) : [];
  const entry = /** @type {Partial<PinnedTemplates> | undefined} */ (
    entries.find((t) => /** @type {{ name?: unknown }} */ (t).name === TEMPLATE_NAME)
  );
  if (!entry) throw new Error(`tools.pin.json has no ${TEMPLATE_NAME} entry`);
  const label = `${TEMPLATE_NAME} ${String(entry.version)}`;
  if (typeof entry.version !== 'string' || !SEMVER.test(entry.version))
    throw new Error(`${label}: version must be an exact semver`);
  if (typeof entry.commit !== 'string' || !COMMIT.test(entry.commit))
    throw new Error(`${label}: commit must be a full 40-character SHA`);
  const url = `${UPSTREAM_REPO}/archive/${entry.commit}.tar.gz`;
  if (entry.url !== url) throw new Error(`${label}: url must pin the archive of ${entry.commit}`);
  if (entry.repo !== UPSTREAM_REPO)
    throw new Error(`${label}: repo must be the upstream nuclei-templates repository`);
  if (typeof entry.sha256 !== 'string' || !DIGEST_HEX.test(entry.sha256))
    throw new Error(`${label}: sha256 must be 64 lowercase hex characters`);
  if (typeof entry.treeSha256 !== 'string' || !DIGEST_HEX.test(entry.treeSha256))
    throw new Error(`${label}: treeSha256 must be 64 lowercase hex characters`);
  if (entry.licence !== 'MIT') throw new Error(`${label}: licence must be MIT`);
  const keep = Array.isArray(entry.keep) ? entry.keep : [];
  if (keep.length === 0) throw new Error(`${label}: keep must list the template directories`);
  for (const dir of keep) {
    if (typeof dir !== 'string' || !SEGMENT.test(dir))
      throw new Error(`${label}: keep entry ${JSON.stringify(dir)} must be a top-level directory`);
  }
  const exclude = Array.isArray(entry.exclude) ? entry.exclude : [];
  for (const rel of exclude) {
    const top = typeof rel === 'string' ? (rel.split('/')[0] ?? '') : '';
    if (typeof rel !== 'string' || !rel.includes('/') || !keep.includes(top) || !safeRel(rel))
      throw new Error(
        `${label}: exclude entry ${JSON.stringify(rel)} must sit under a kept directory`,
      );
  }
  return {
    name: TEMPLATE_NAME,
    version: entry.version,
    repo: entry.repo,
    commit: entry.commit,
    url,
    sha256: entry.sha256,
    treeSha256: entry.treeSha256,
    licence: entry.licence,
    keep,
    exclude,
  };
}

/**
 * Lists every regular file below `root` as a sorted, posix-relative path. Symlinks and special files are refused so
 * the digest covers exactly the bytes that ship.
 * @param {string} root
 * @returns {{ rel: string, abs: string }[]}
 */
export function listFiles(root) {
  /** @type {{ rel: string, abs: string }[]} */
  const out = [];
  /** @param {string} dir @param {string} prefix */
  const walk = (dir, prefix) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = prefix === '' ? ent.name : `${prefix}/${ent.name}`;
      if (ent.isSymbolicLink())
        throw new Error(`${rel}: symlinks are not allowed in the templates`);
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) out.push({ rel, abs });
      else throw new Error(`${rel}: special files are not allowed in the templates`);
    }
  };
  walk(root, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * sha256 over the sorted manifest `<relpath>\0<sha256 of file>\n` for every file under `root`.
 * @param {string} root
 * @returns {string} lowercase hex
 */
export function treeDigest(root) {
  const h = createHash('sha256');
  for (const f of listFiles(root)) {
    const fileHash = createHash('sha256').update(readFileSync(f.abs)).digest('hex');
    h.update(`${f.rel}\0${fileHash}\n`);
  }
  return h.digest('hex');
}

/**
 * @param {string} archive
 * @param {string} dst
 */
function untar(archive, dst) {
  const r = spawnSync('tar', ['-xzf', archive, '-C', dst, '--strip-components=1'], {
    encoding: 'utf8',
    input: '',
    timeout: TAR_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new Error(`tar failed (${r.status}): ${r.stderr.trim()}`);
}

/**
 * Keeps only the pinned directories and removes the pinned exclusions. Anything else at the top level (docs, CI
 * config, the cloud, code, file, headless, javascript and workflow categories, and root files) is deleted before the
 * digest is taken.
 * @param {string} staged
 * @param {PinnedTemplates} pin
 */
function prune(staged, pin) {
  const top = readdirSync(staged);
  for (const dir of pin.keep) {
    if (!top.includes(dir)) throw new Error(`${pin.name}: archive has no kept directory ${dir}`);
  }
  for (const entry of top) {
    if (!pin.keep.includes(entry))
      rmSync(path.join(staged, entry), { recursive: true, force: true });
  }
  for (const rel of pin.exclude) {
    const target = path.join(staged, rel);
    if (!existsSync(target))
      throw new Error(`${pin.name}: excluded path ${rel} is not in the archive`);
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Downloads, verifies, prunes and digests the pinned templates into `dest` (for example
 * /opt/bw/templates/official). Nothing at `dest` is touched unless every check holds. The pinned commit, the tree
 * digest and the file count are recorded in `dest/.bw-template-pin.json` for the run manifest (IMAGE-008).
 * @param {string} pinFile
 * @param {string} dest
 * @param {{ fetchImpl?: (u: string) => Promise<Response> }} [opts]
 * @returns {Promise<{ commit: string, treeSha256: string, files: number }>}
 */
export async function installTemplates(pinFile, dest, opts = {}) {
  const pin = templatesPin(JSON.parse(readFileSync(pinFile, 'utf8')));
  const label = `${pin.name} ${pin.version}`;
  const bytes = await fetchVerified(pin.url, pin.sha256, label, opts.fetchImpl);
  const parent = path.dirname(path.resolve(dest));
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(path.join(parent, '.bw-templates-'));
  try {
    const archive = path.join(work, 'templates.tar.gz');
    writeFileSync(archive, bytes);
    const staged = path.join(work, 'tree');
    mkdirSync(staged);
    untar(archive, staged);
    prune(staged, pin);
    const digest = treeDigest(staged);
    if (digest !== pin.treeSha256) {
      throw new Error(
        `${label} tree: sha256 mismatch (pinned ${pin.treeSha256}, computed ${digest})`,
      );
    }
    const files = listFiles(staged).length;
    rmSync(dest, { recursive: true, force: true });
    renameSync(staged, dest);
    writeFileSync(
      path.join(dest, PIN_FILE_NAME),
      `${JSON.stringify({ name: pin.name, version: pin.version, commit: pin.commit, treeSha256: digest }, null, 2)}\n`,
    );
    return { commit: pin.commit, treeSha256: digest, files };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** @param {unknown} err */
function onFailed(err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`install-templates: ${message}\n`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [pinFile, dest] = process.argv.slice(2);
  if (!pinFile || !dest) {
    process.stderr.write('usage: install-templates.mjs <tools.pin.json> <dest-dir>\n');
    process.exit(EX_USAGE);
  }
  installTemplates(pinFile, dest).then(
    (r) => process.stdout.write(`installed ${TEMPLATE_NAME} ${r.commit} (${r.files} files)\n`),
    onFailed,
  );
}
