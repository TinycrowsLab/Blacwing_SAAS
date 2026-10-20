// Shared helpers for the scripts/ self-tests: builds a minimal, valid copy of the
// repository layout in a temporary directory so each test can introduce one defect.

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_APPS,
  EXPECTED_DIRS,
  EXPECTED_DIR_FILES,
  EXPECTED_PACKAGES,
  GITHUB_LAYOUT,
  NODE_ENGINE,
  ROOT_FILES,
} from './check-layout.mjs';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

/**
 * A parsed JSON object that a test inspects or edits in place. Its values stay `unknown` until
 * the test narrows them with asObject / asArray, so no untyped value leaks into a check.
 * @typedef {Record<string, unknown>} JsonObject
 */

/**
 * Narrows a value to a JSON object, failing the test when it is not one.
 * @param {unknown} value
 * @param {string} [what]  names the value in the assertion message
 * @returns {JsonObject}
 */
export function asObject(value, what = 'value') {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${what} must be a JSON object`,
  );
  return /** @type {JsonObject} */ (value);
}

/**
 * Narrows a value to an array, failing the test when it is not one.
 * @param {unknown} value
 * @param {string} [what]
 * @returns {unknown[]}
 */
export function asArray(value, what = 'value') {
  assert.ok(Array.isArray(value), `${what} must be an array`);
  return /** @type {unknown[]} */ (value);
}

/**
 * Narrows away `undefined` (for example the result of `Array#find`), failing the test otherwise.
 * @template T
 * @param {T | undefined} value
 * @param {string} [what]
 * @returns {T}
 */
export function defined(value, what = 'value') {
  assert.ok(value !== undefined, `${what} must be defined`);
  return value;
}

/**
 * Parses JSON text that must hold an object (a CLI's stdout, a manifest, ...).
 * @param {string} text
 * @param {string} [what]
 * @returns {JsonObject}
 */
export function parseJsonObject(text, what = 'JSON document') {
  return asObject(JSON.parse(text), what);
}

/**
 * Reads a JSON file that must hold an object.
 * @param {string} file
 * @returns {JsonObject}
 */
export function readJsonObject(file) {
  return parseJsonObject(readFileSync(file, 'utf8'), file);
}

/**
 * @param {string} file
 * @param {unknown} value
 */
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Writes a well-formed workspace member stub (no dependencies, so installs stay offline).
 * @param {string} root
 * @param {string} dir  e.g. "packages/db"
 * @param {{ name?: string, private?: boolean }} [overrides]
 */
export function writeMember(root, dir, overrides = {}) {
  const name = overrides.name ?? `@blackwing/${path.basename(dir)}`;
  writeJson(path.join(root, dir, 'package.json'), {
    name,
    version: '0.0.0',
    private: overrides.private ?? true,
    type: 'module',
  });
  mkdirSync(path.join(root, dir, 'src'), { recursive: true });
  writeFileSync(path.join(root, dir, 'src', 'index.ts'), `export const name = "${name}";\n`);
}

/**
 * Creates a temporary directory holding a layout that passes every check.
 * @returns {{ root: string, cleanup: () => void }}
 */
export function makeValidFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-layout-'));
  for (const file of ROOT_FILES) {
    if (file === 'package.json' || file === 'pnpm-workspace.yaml') continue;
    writeFileSync(path.join(root, file), 'placeholder\n');
  }
  writeJson(path.join(root, 'package.json'), {
    name: '@blackwing/root',
    version: '0.0.0',
    private: true,
    packageManager: 'pnpm@9.15.0',
    engines: { node: NODE_ENGINE },
    scripts: { preinstall: 'node scripts/preinstall.mjs' },
  });
  writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - "apps/*"\n  - "packages/*"\n',
  );
  for (const app of EXPECTED_APPS) writeMember(root, `apps/${app}`);
  for (const pkg of EXPECTED_PACKAGES) writeMember(root, `packages/${pkg}`);
  for (const [dir, children] of Object.entries(EXPECTED_DIRS)) {
    for (const child of children) {
      mkdirSync(path.join(root, dir, child), { recursive: true });
      writeFileSync(path.join(root, dir, child, '.gitkeep'), '');
    }
  }
  for (const [dir, files] of Object.entries(EXPECTED_DIR_FILES)) {
    for (const file of files) writeFileSync(path.join(root, dir, file), 'placeholder\n');
  }
  for (const child of GITHUB_LAYOUT.dirs)
    mkdirSync(path.join(root, '.github', child), { recursive: true });
  for (const file of GITHUB_LAYOUT.files)
    writeFileSync(path.join(root, '.github', file), 'placeholder\n');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const script of ['check-layout.mjs', 'preinstall.mjs']) {
    copyFileSync(path.join(SCRIPTS_DIR, script), path.join(root, 'scripts', script));
  }
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Environment for child processes: drops inherited npm/pnpm configuration so a nested
 * pnpm or preinstall run behaves like a fresh shell.
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function cleanEnv(extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|pnpm_)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
