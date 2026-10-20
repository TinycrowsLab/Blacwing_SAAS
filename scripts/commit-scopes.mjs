#!/usr/bin/env node
// Allowed Conventional Commit scopes (FOUND-006, #8), read by commitlint.config.mjs.
//
// The list is generated, never hand-maintained, so it cannot drift from the repository:
//   - every pnpm workspace member, by directory name (`egress-gateway`, `config`, `ui`, ...);
//   - every epic key from the label catalogue `.github/labels.yml`, lowercased (`egress`, `found`,
//     `devenv`, ...), so a commit can name the epic it belongs to;
//   - the fixed top-level directories of CONTEXT_PACK §6 and their children (scripts/check-layout.mjs);
//   - a short list of repository-wide scopes (REPO_SCOPES).
//
// A missing or invalid source throws instead of returning a shorter list: commitlint must not
// silently accept or reject scopes because a file failed to parse.
//
// Usage: node scripts/commit-scopes.mjs [--root <dir>]   prints one allowed scope per line.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPECTED_DIRS, SCOPE, parseWorkspaceGlobs } from './check-layout.mjs';
import { MANIFEST_PATH, loadManifest } from './sync-labels.mjs';

/** Scopes for changes that belong to the repository as a whole rather than one member. */
export const REPO_SCOPES = Object.freeze([
  'repo', // root tooling, configs and workspace wiring
  'deps', // dependency bumps (Renovate)
  'release', // release automation (CI-016)
  'design', // design/ (Claude Design export)
  'scripts', // scripts/ repository tooling
  'github', // .github/ templates, CODEOWNERS, labels
  'arch', // architecture docs and diagrams
  'readme', // README.md
]);

/** Label-catalogue group whose labels name the epics (`epic:EGRESS` -> `egress`). */
export const EPIC_GROUP = 'epic';

const SCOPE_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * @param {string} file
 * @returns {boolean}
 */
function isDirectory(file) {
  return existsSync(file) && statSync(file).isDirectory();
}

/**
 * Workspace member scopes: the directory of every member matched by the `packages:` globs of
 * pnpm-workspace.yaml (only the `<dir>/*` form this repository uses). A member must hold a
 * package.json named `@blackwing/<dir>`, as scripts/check-layout.mjs requires.
 * @param {string} root
 * @returns {string[]}
 */
export function workspaceScopes(root) {
  const file = path.join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) throw new Error(`${file}: missing, cannot derive commit scopes`);
  const globs = parseWorkspaceGlobs(readFileSync(file, 'utf8'));
  if (globs === null || globs.length === 0) {
    throw new Error(`${file}: no "packages:" list found, cannot derive commit scopes`);
  }
  /** @type {string[]} */
  const scopes = [];
  for (const glob of globs) {
    const match = /^([a-z0-9-]+)\/\*$/.exec(glob);
    if (match?.[1] === undefined) {
      throw new Error(`${file}: unsupported workspace glob "${glob}" (expected "<dir>/*")`);
    }
    const parent = path.join(root, match[1]);
    if (!isDirectory(parent)) continue;
    for (const entry of readdirSync(parent).sort()) {
      const manifest = path.join(parent, entry, 'package.json');
      if (!existsSync(manifest)) continue;
      const parsed = /** @type {unknown} */ (JSON.parse(readFileSync(manifest, 'utf8')));
      const name =
        parsed !== null && typeof parsed === 'object' && 'name' in parsed ? parsed.name : null;
      if (name !== `${SCOPE}/${entry}`) {
        throw new Error(`${manifest}: name must be "${SCOPE}/${entry}" to be a commit scope`);
      }
      scopes.push(entry);
    }
  }
  return scopes;
}

/**
 * Epic scopes: the key of every `epic:` label in the label catalogue, lowercased.
 * @param {string} root
 * @returns {string[]}
 */
export function epicScopes(root) {
  const { manifest, errors } = loadManifest(path.join(root, MANIFEST_PATH));
  if (manifest === null) {
    throw new Error(`${MANIFEST_PATH}: cannot derive commit scopes:\n  ${errors.join('\n  ')}`);
  }
  const group = manifest.groups.find((g) => g.id === EPIC_GROUP);
  const prefix = group?.prefix ?? null;
  if (group === undefined || prefix === null) {
    throw new Error(`${MANIFEST_PATH}: no "${EPIC_GROUP}" label group with a prefix`);
  }
  return group.labels.map((label) => label.name.slice(prefix.length).toLowerCase());
}

/**
 * Scopes for the fixed top-level directories of CONTEXT_PACK §6 and their children
 * (`infra`, `compose`, `helm`, `docs`, `adr`, `eval`, `harness`, ...).
 * @returns {string[]}
 */
export function layoutScopes() {
  return Object.entries(EXPECTED_DIRS).flatMap(([dir, children]) => [dir, ...children]);
}

/**
 * Every allowed scope, de-duplicated and sorted.
 * @param {string} root  repository root
 * @returns {string[]}
 */
export function allowedScopes(root) {
  const scopes = new Set([
    ...workspaceScopes(root),
    ...epicScopes(root),
    ...layoutScopes(),
    ...REPO_SCOPES,
  ]);
  for (const scope of scopes) {
    if (!SCOPE_SHAPE.test(scope)) {
      throw new Error(`commit scope "${scope}" is not lowercase kebab-case`);
    }
  }
  return [...scopes].sort();
}

/**
 * @param {string[]} argv
 * @returns {string}  the repository root to read
 */
function parseRoot(argv) {
  const i = argv.indexOf('--root');
  if (i === -1) return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const value = argv[i + 1];
  if (value === undefined) throw new Error('--root needs a directory');
  return path.resolve(value);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(`${allowedScopes(parseRoot(process.argv.slice(2))).join('\n')}\n`);
}
