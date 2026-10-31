#!/usr/bin/env node
// Build-time installer for the bundled wordlists (IMAGE-006, #604). Runs once in the image's `tools` stage:
// `node install-wordlists.mjs <wordlists.pin.json> <dstDir>`. Each vendored list is checked against its pinned
// sha256, its licence must be on the allowlist and recorded, its bytes must be valid UTF-8, and the whole set
// must fit IMAGE_WORDLISTS_MAX_MIB. Any violation throws, so the build fails. Bytes are copied verbatim.
// Node built-ins only. The same checks run in CI via scripts/check-sandbox-wordlists.mjs.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_LICENCES = Object.freeze([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC0-1.0',
]);
export const DEFAULT_MAX_MIB = 64;
const MIB = 1_048_576; // bytes per MiB
const EX_USAGE = 64;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const CATEGORY = /^[a-z0-9][a-z0-9-]*$/;
const WORDLIST_PREFIX = 'wordlists/';

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {Uint8Array} bytes
 * @returns {string} lowercase hex sha256
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A relative pin path is safe only when it stays under wordlists/ with no traversal or absolute form.
 * @param {unknown} rel
 * @returns {boolean}
 */
const safeRelative = (rel) =>
  typeof rel === 'string' &&
  rel.startsWith(WORDLIST_PREFIX) &&
  path.posix.normalize(rel) === rel &&
  !rel.split('/').includes('..');

/**
 * A list file is a safe relative path that names a .txt list.
 * @param {unknown} rel
 * @returns {boolean}
 */
const safeListFile = (rel) => safeRelative(rel) && typeof rel === 'string' && rel.endsWith('.txt');

/**
 * Validates a parsed pin against the bytes it names. Pure: the caller supplies `readBytes`, which returns
 * undefined for a missing file. Returns every problem found, so a reviewer sees them all at once.
 * @param {unknown} pin parsed wordlists.pin.json
 * @param {(rel: string) => Uint8Array | undefined} readBytes
 * @param {number} [maxMib]
 * @returns {{ errors: string[], lists: Array<{ name: string, category: string, file: string, sha256: string, version: string, licence: string, source: string, bytes: number, lines: number }>, licences: Array<{ licence: string, file: string, sha256: string }>, totalBytes: number }}
 */
export function checkWordlistPin(pin, readBytes, maxMib = DEFAULT_MAX_MIB) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Array<{ name: string, category: string, file: string, sha256: string, version: string, licence: string, source: string, bytes: number, lines: number }>} */
  const lists = [];
  /** @type {Array<{ licence: string, file: string, sha256: string }>} */
  const licences = [];
  if (!isObject(pin) || pin.schema !== 1) {
    return {
      errors: ['wordlists.pin.json must be an object with schema 1'],
      lists,
      licences,
      totalBytes: 0,
    };
  }
  const licenceNames = new Set();
  const licenceEntries = Array.isArray(pin.licences) ? pin.licences : [];
  if (!Array.isArray(pin.licences)) errors.push('licences must be an array');
  for (const l of licenceEntries) {
    if (
      !isObject(l) ||
      typeof l.licence !== 'string' ||
      typeof l.sha256 !== 'string' ||
      !safeRelative(l.file)
    ) {
      errors.push('each licence needs licence, a wordlists/ file path and a sha256');
      continue;
    }
    if (!ALLOWED_LICENCES.includes(l.licence))
      errors.push(`licence ${l.licence} is not on the allowlist`);
    if (!SHA256.test(l.sha256))
      errors.push(`licence ${String(l.file)}: sha256 must be 64 lowercase hex characters`);
    const bytes = readBytes(l.file);
    if (!bytes) errors.push(`licence file ${String(l.file)} is missing`);
    else if (sha256Hex(bytes) !== l.sha256)
      errors.push(`licence file ${String(l.file)}: sha256 mismatch`);
    licenceNames.add(l.licence);
    licences.push({ licence: l.licence, file: l.file, sha256: l.sha256 });
  }

  const entries = Array.isArray(pin.lists) ? pin.lists : [];
  if (!Array.isArray(pin.lists) || entries.length === 0)
    errors.push('lists must be a non-empty array');
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Set<string>} */
  const files = new Set();
  let totalBytes = 0;
  for (const entry of entries) {
    if (!isObject(entry)) {
      errors.push('each list must be an object');
      continue;
    }
    const label = typeof entry.name === 'string' ? entry.name : '(unnamed)';
    if (typeof entry.name !== 'string' || !NAME.test(entry.name))
      errors.push(`${label}: name must be a lowercase slug`);
    if (names.has(label)) errors.push(`${label}: listed twice`);
    names.add(label);
    if (typeof entry.category !== 'string' || !CATEGORY.test(entry.category))
      errors.push(`${label}: category must be a lowercase slug`);
    if (typeof entry.version !== 'string' || !COMMIT.test(entry.version))
      errors.push(`${label}: version must be the 40-hex upstream commit`);
    if (typeof entry.licence !== 'string' || !ALLOWED_LICENCES.includes(entry.licence)) {
      errors.push(`${label}: licence ${String(entry.licence)} is not on the allowlist`);
    } else if (!licenceNames.has(entry.licence)) {
      errors.push(`${label}: licence ${entry.licence} has no licence text recorded in licences`);
    }
    if (typeof entry.source !== 'string' || !entry.source.startsWith('https://'))
      errors.push(`${label}: source must be an https URL`);
    if (!safeListFile(entry.file)) {
      errors.push(`${label}: file must be a .txt path under wordlists/`);
      continue;
    }
    if (files.has(entry.file)) errors.push(`${label}: file ${String(entry.file)} is listed twice`);
    files.add(entry.file);
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      errors.push(`${label}: sha256 must be 64 lowercase hex characters`);
      continue;
    }
    const bytes = readBytes(entry.file);
    if (!bytes) {
      errors.push(`${label}: file ${String(entry.file)} is missing`);
      continue;
    }
    if (sha256Hex(bytes) !== entry.sha256) {
      errors.push(`${label}: sha256 mismatch for ${String(entry.file)}`);
      continue;
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      errors.push(`${label}: ${String(entry.file)} is not valid UTF-8`);
      continue;
    }
    const text = Buffer.from(bytes).toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0).length;
    if (lines === 0) errors.push(`${label}: ${String(entry.file)} has no entries`);
    totalBytes += bytes.byteLength;
    lists.push({
      name: label,
      category: entry.category ?? '',
      file: entry.file,
      sha256: entry.sha256,
      version: entry.version ?? '',
      licence: entry.licence ?? '',
      source: entry.source ?? '',
      bytes: bytes.byteLength,
      lines,
    });
  }
  if (totalBytes > maxMib * MIB) {
    errors.push(`wordlists total ${totalBytes} bytes exceeds IMAGE_WORDLISTS_MAX_MIB=${maxMib}`);
  }
  return { errors, lists, licences, totalBytes };
}

/**
 * Verifies the pin, then copies every list (verbatim) into `<dstDir>/<category>/` and the licence texts into
 * `<dstDir>/LICENSES/`, and writes `<dstDir>/manifest.json`. Throws on any error, before anything is written.
 * @param {string} pinFile path to wordlists.pin.json; `file` paths resolve against its directory
 * @param {string} dstDir
 * @param {number} [maxMib]
 * @returns {{ lists: number, totalBytes: number }}
 */
export function installWordlists(pinFile, dstDir, maxMib = DEFAULT_MAX_MIB) {
  const root = path.dirname(pinFile);
  /** @type {unknown} */
  const pin = JSON.parse(readFileSync(pinFile, 'utf8'));
  /** @param {string} rel */
  const readBytes = (rel) => {
    const abs = path.join(root, rel);
    return existsSync(abs) ? readFileSync(abs) : undefined;
  };
  const checked = checkWordlistPin(pin, readBytes, maxMib);
  if (checked.errors.length > 0) throw new Error(checked.errors.join('\n'));

  const licenceDir = path.join(dstDir, 'LICENSES');
  mkdirSync(licenceDir, { recursive: true });
  for (const l of checked.licences) {
    writeFileSync(path.join(licenceDir, path.basename(l.file)), readBytes(l.file) ?? '', {
      mode: 0o644,
    });
  }
  for (const l of checked.lists) {
    const dir = path.join(dstDir, l.category);
    mkdirSync(dir, { recursive: true });
    const out = path.join(dir, path.basename(l.file));
    writeFileSync(out, readBytes(l.file) ?? '', { mode: 0o644 });
    l.file = path.posix.join(l.category, path.basename(l.file));
  }
  const manifest = {
    schema: 1,
    maxMib,
    totalBytes: checked.totalBytes,
    licences: checked.licences.map((l) => ({
      licence: l.licence,
      file: `LICENSES/${path.basename(l.file)}`,
      sha256: l.sha256,
    })),
    lists: checked.lists,
  };
  writeFileSync(path.join(dstDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { lists: checked.lists.length, totalBytes: checked.totalBytes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [pinFile, dstDir] = process.argv.slice(2);
  if (!pinFile || !dstDir) {
    process.stderr.write('usage: install-wordlists.mjs <wordlists.pin.json> <dstDir>\n');
    process.exit(EX_USAGE);
  }
  const maxMib = Number(process.env.IMAGE_WORDLISTS_MAX_MIB ?? DEFAULT_MAX_MIB);
  if (!Number.isInteger(maxMib) || maxMib <= 0) {
    process.stderr.write('install-wordlists: IMAGE_WORDLISTS_MAX_MIB must be a positive integer\n');
    process.exit(EX_USAGE);
  }
  try {
    const { lists, totalBytes } = installWordlists(pinFile, dstDir, maxMib);
    process.stdout.write(`installed ${lists} wordlists (${totalBytes} bytes)\n`);
  } catch (err) {
    process.stderr.write(
      `install-wordlists: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
