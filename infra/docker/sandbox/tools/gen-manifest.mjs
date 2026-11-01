#!/usr/bin/env node
// Tool-manifest generator for bw-sandbox (IMAGE-008, #606). Runs once in the image's `tools` stage, after every
// pinned tool, the wordlists and the nuclei templates are installed:
//   node gen-manifest.mjs --tools-pin <tools.pin.json> --scanners-pin <scanners.pin.json> \
//     --bin-dir <bin> --templates-dir <templates> --base-image <image@sha256:...> --out <manifest.json>
// SOURCE_DATE_EPOCH (integer seconds) sets generatedAt, so two identical builds emit identical bytes.
//
// It re-hashes every installed binary in the bin directory and fails the build unless the set of installed files
// equals the set of pinned entrypoints (nothing missing, nothing unpinned) and each sha256 equals its pin, so a
// partial install or a planted binary cannot produce a manifest. The output matches the ToolManifest Zod schema in
// packages/contracts/src/tool-manifest.ts (the schema is not importable here: this runs before any npm install).
// Node built-ins only.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIGEST_HEX = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /@(sha256:[0-9a-f]{64})$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const CHROMIUM_REVISION = /^\d+$/;
const TOOL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const EPOCH = /^\d+$/;
const MAX_EPOCH = 253_402_300_799; // 9999-12-31T23:59:59Z, the last instant an ISO-8601 year can express
const MS_PER_SECOND = 1000;

/**
 * @typedef {{ name: string, version: string, sha256: string, licence: string, source: string }} ToolEntry
 * @typedef {{
 *   name: string, entrypoint: string, version: string, licence: string, source: string, binarySha256: string
 * }} PinnedTool
 * @typedef {{
 *   imageBaseDigest: string, imageDigest: null, generatedAt: string, tools: ToolEntry[],
 *   nucleiTemplatesCommit: string, playwrightVersion: string, chromiumRevision: string
 * }} ToolManifest
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Hashes a file. Binaries are read whole: the largest (trivy) is about 170 MiB, which is a Buffer outside the V8 heap.
 * @param {string} file
 * @returns {string} lowercase hex digest
 */
export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Lists the bin directory as name -> path. Only regular files may sit there: a symlink or a directory would let a
 * pinned name point outside the verified tree, so either one fails the build.
 * @param {string} binDir
 * @returns {Map<string, string>}
 */
export function listInstalled(binDir) {
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const entry of readdirSync(binDir).sort()) {
    const full = path.join(binDir, entry);
    if (!lstatSync(full).isFile()) {
      throw new Error(
        `bin entry ${entry} is not a regular file (symlinks and directories are refused)`,
      );
    }
    files.set(entry, full);
  }
  return files;
}

/**
 * Builds the manifest from parsed pins and the measured binaries. Pure: all IO happens in main(), so the rules can be
 * tested against fabricated inputs. Throws one Error that lists every violation, so the build log shows them all.
 *
 * @param {{
 *   toolsPin: unknown, scannersPin: unknown,
 *   installed: Map<string, string>, // entrypoint name -> measured sha256 of the installed file
 *   templatesPin: unknown, // parsed .bw-template-pin.json written by install-templates.mjs
 *   baseImage: string, // e.g. node:22-bookworm-slim@sha256:...
 *   sourceDateEpoch: string
 * }} input
 * @returns {ToolManifest}
 */
export function buildToolManifest({
  toolsPin,
  scannersPin,
  installed,
  templatesPin,
  baseImage,
  sourceDateEpoch,
}) {
  /** @type {string[]} */
  const errors = [];
  const pins = [
    ...pinnedTools(toolsPin, 'tools.pin.json', errors),
    ...pinnedTools(scannersPin, 'scanners.pin.json', errors),
  ];

  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const pin of pins) {
    seen.set(pin.entrypoint, (seen.get(pin.entrypoint) ?? 0) + 1);
  }
  for (const [entrypoint, count] of seen) {
    if (count > 1) errors.push(`${entrypoint}: entrypoint pinned ${count} times`);
  }
  for (const pin of pins) {
    const measured = installed.get(pin.entrypoint);
    if (measured === undefined) {
      errors.push(
        `${pin.name}: pinned entrypoint ${pin.entrypoint} is not installed in the bin directory`,
      );
    } else if (measured !== pin.binarySha256) {
      errors.push(
        `${pin.name}: installed ${pin.entrypoint} sha256 ${measured} does not match pinned ${pin.binarySha256}`,
      );
    }
  }
  const pinnedEntrypoints = new Set(pins.map((p) => p.entrypoint));
  for (const name of installed.keys()) {
    if (!pinnedEntrypoints.has(name)) {
      errors.push(
        `${name}: installed in the bin directory but not pinned in tools.pin.json or scanners.pin.json`,
      );
    }
  }

  const nucleiTemplatesCommit = templatesCommit(templatesPin, errors);
  const browser = browserPins(toolsPin, errors);
  const imageDigest = IMAGE_DIGEST.exec(baseImage)?.[1];
  if (imageDigest === undefined) errors.push('base image must be pinned by @sha256: digest');
  if (!EPOCH.test(sourceDateEpoch) || Number(sourceDateEpoch) > MAX_EPOCH) {
    errors.push('SOURCE_DATE_EPOCH must be a non-negative integer of at most 9999-12-31');
  }

  if (errors.length > 0 || imageDigest === undefined) {
    throw new Error(`gen-manifest: ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
  }

  const tools = pins
    .map((pin) => ({
      name: pin.name,
      version: pin.version,
      sha256: pin.binarySha256,
      licence: pin.licence,
      source: pin.source,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    imageBaseDigest: imageDigest,
    imageDigest: null,
    generatedAt: new Date(Number(sourceDateEpoch) * MS_PER_SECOND).toISOString(),
    tools,
    nucleiTemplatesCommit,
    playwrightVersion: browser.playwright,
    chromiumRevision: browser.chromiumRevision,
  };
}

/**
 * Reads the tools from one pin file. A tool without `entrypoint` is installed under its own name.
 * @param {unknown} pinFile
 * @param {string} label
 * @param {string[]} errors
 * @returns {PinnedTool[]}
 */
function pinnedTools(pinFile, label, errors) {
  if (!isObject(pinFile) || !Array.isArray(pinFile.tools)) {
    errors.push(`${label}: tools must be an array`);
    return [];
  }
  /** @type {PinnedTool[]} */
  const out = [];
  for (const raw of /** @type {unknown[]} */ (pinFile.tools)) {
    if (!isObject(raw)) {
      errors.push(`${label}: every tool must be an object`);
      continue;
    }
    const { name, version, licence, source, binarySha256 } = raw;
    const id = typeof name === 'string' ? name : '(unnamed)';
    if (typeof name !== 'string' || !TOOL_NAME.test(name))
      errors.push(`${label}: ${id} has an invalid name`);
    if (typeof version !== 'string' || version.length === 0)
      errors.push(`${id}: version is required`);
    if (typeof licence !== 'string' || licence.length === 0)
      errors.push(`${id}: licence is required`);
    if (typeof source !== 'string' || !source.startsWith('https://')) {
      errors.push(`${id}: source must be an https URL`);
    }
    if (typeof binarySha256 !== 'string' || !DIGEST_HEX.test(binarySha256)) {
      errors.push(`${id}: binarySha256 must be 64 lowercase hex characters`);
    }
    if (
      typeof name !== 'string' ||
      typeof version !== 'string' ||
      typeof licence !== 'string' ||
      typeof source !== 'string' ||
      typeof binarySha256 !== 'string'
    ) {
      continue;
    }
    const entrypoint = typeof raw.entrypoint === 'string' ? raw.entrypoint : name;
    out.push({ name, entrypoint, version, licence, source, binarySha256 });
  }
  return out;
}

/**
 * @param {unknown} templatesPin parsed .bw-template-pin.json
 * @param {string[]} errors
 * @returns {string} the pinned nuclei-templates commit ('' when the pin is malformed; errors then record why)
 */
function templatesCommit(templatesPin, errors) {
  const commit = isObject(templatesPin) ? templatesPin.commit : undefined;
  if (typeof commit !== 'string' || !COMMIT_SHA.test(commit)) {
    errors.push('templates: .bw-template-pin.json must record a 40-hex commit');
    return '';
  }
  return commit;
}

/**
 * Reads the Playwright and Chromium pins that install-browser.sh already verified.
 * @param {unknown} toolsPin
 * @param {string[]} errors
 * @returns {{ playwright: string, chromiumRevision: string }}
 */
function browserPins(toolsPin, errors) {
  const browser = isObject(toolsPin) && isObject(toolsPin.browser) ? toolsPin.browser : undefined;
  const chromium = browser && isObject(browser.chromium) ? browser.chromium : undefined;
  const playwright = browser?.playwright;
  const revision = chromium?.revision;
  if (typeof playwright !== 'string' || !SEMVER.test(playwright)) {
    errors.push('browser.playwright must be an exact semver');
  }
  if (typeof revision !== 'string' || !CHROMIUM_REVISION.test(revision)) {
    errors.push('browser.chromium.revision must be digits');
  }
  return {
    playwright: typeof playwright === 'string' ? playwright : '',
    chromiumRevision: typeof revision === 'string' ? revision : '',
  };
}

/**
 * Serialises with sorted object keys and a trailing newline, so the bytes depend only on the content.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/**
 * @param {unknown} v
 * @returns {unknown}
 */
function sortKeys(v) {
  if (Array.isArray(v)) return /** @type {unknown[]} */ (v).map((item) => sortKeys(item));
  if (!isObject(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortKeys(v[k])]),
  );
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i] ?? '';
    const value = argv[i + 1];
    if (!key.startsWith('--') || value === undefined) throw new Error(`usage: bad argument ${key}`);
    args[key.slice(2)] = value;
  }
  return args;
}

/**
 * @param {string} file
 * @returns {unknown}
 */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * @param {string[]} argv
 * @returns {void}
 */
export function main(argv) {
  const args = parseArgs(argv);
  const required = ['tools-pin', 'scanners-pin', 'bin-dir', 'templates-dir', 'base-image', 'out'];
  for (const key of required) {
    if (args[key] === undefined) throw new Error(`usage: missing --${key}`);
  }
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch === undefined)
    throw new Error('SOURCE_DATE_EPOCH must be set for a reproducible manifest');

  /** @type {Map<string, string>} */
  const installed = new Map();
  for (const [name, file] of listInstalled(args['bin-dir'] ?? '')) {
    installed.set(name, sha256File(file));
  }
  const manifest = buildToolManifest({
    toolsPin: readJson(args['tools-pin'] ?? ''),
    scannersPin: readJson(args['scanners-pin'] ?? ''),
    installed,
    templatesPin: readJson(path.join(args['templates-dir'] ?? '', '.bw-template-pin.json')),
    baseImage: args['base-image'] ?? '',
    sourceDateEpoch,
  });
  writeFileSync(args.out ?? '', canonicalJson(manifest));
  process.stdout.write(`gen-manifest: ${manifest.tools.length} tools\n`);
}

/** @param {unknown} err */
function onFailed(err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    onFailed(err);
  }
}
