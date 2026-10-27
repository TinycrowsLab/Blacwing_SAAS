#!/usr/bin/env node
// Verifies that the repository layout matches docs/architecture/CONTEXT_PACK.md §6
// and that every pnpm workspace member is well-formed.
//
// Detects:
//   - missing or unexpected (drifted) apps, packages and fixed directories;
//   - workspace members without a package.json, with an unparsable one, with a
//     name other than `@blackwing/<dir>`, or not marked `private`;
//   - duplicate package names across the workspace (pnpm itself does not fail on these);
//   - directory names that are not lowercase kebab-case or that collide on
//     case-insensitive filesystems (macOS, Windows);
//   - a root package.json / pnpm-workspace.yaml that deviates from the agreed contract.
//
// Usage: node scripts/check-layout.mjs [--root <dir>] [--quiet]
// Prints a structured JSON summary on stdout; exits non-zero when any check fails.
// It also runs from the root `preinstall` hook so `pnpm install` fails loudly on drift.
//
// When an issue legitimately adds or removes an app/package/directory, update the
// constants below and CONTEXT_PACK §6 in the same commit.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCOPE = '@blackwing';

export const EXPECTED_APPS = Object.freeze([
  'web',
  'api',
  'worker',
  'agent-runtime',
  'sandbox-controller',
  'model-gateway',
  'egress-gateway',
  'session-manager',
  'cli',
]);

export const EXPECTED_PACKAGES = Object.freeze([
  'contracts',
  'db',
  'domain',
  'policy',
  'agents',
  'api-client',
  'mcp-tools',
  'memory',
  'replay',
  'oob',
  'evidence',
  'crypto',
  'secrets',
  'audit',
  'notify',
  'events',
  'connectors',
  'reporting',
  'cost',
  'config',
  'logger',
  'ids',
  'time',
  'errors',
  'telemetry',
  'workflow-shared',
  'ui',
  'testing',
]);

/** Fixed directories whose immediate children must match exactly. */
export const EXPECTED_DIRS = Object.freeze({
  infra: Object.freeze(['tofu', 'helm', 'k3s', 'docker', 'compose', 'keycloak']),
  eval: Object.freeze(['targets', 'ground-truth', 'harness']),
  docs: Object.freeze(['adr', 'architecture', 'runbooks', 'api', 'user']),
});

/**
 * Files that must exist directly inside a fixed directory (label catalogue doc: FOUND-016, #18;
 * dev-host bootstrap and its pinned-version manifest: DEVENV-001, #155; the integration-test image
 * manifest `images.lock`: CI-004).
 */
export const EXPECTED_DIR_FILES = Object.freeze({
  docs: Object.freeze(['labels.md', 'site.json', 'CONTRIBUTING-docs.md']),
  infra: Object.freeze(['bootstrap.sh', 'images.lock', 'versions.env']),
});

/**
 * `.github/` entries (CONTEXT_PACK §6). `dirs` and `files` must exist with that kind;
 * `optional` entries are allowed but not required. The templates, CODEOWNERS and the
 * label catalogue (`labels.yml`) arrived with FOUND-016 (#18); `actions` (reusable composite
 * actions such as `setup`) with CI-001 (#135); the dependency-review policy with CI-014 (#148) and the CodeQL config with CI-013 (#147).
 */
export const GITHUB_LAYOUT = Object.freeze({
  dirs: Object.freeze(['workflows', 'actions', 'ISSUE_TEMPLATE', 'rulesets']),
  files: Object.freeze([
    'PULL_REQUEST_TEMPLATE.md',
    'CODEOWNERS',
    'labels.yml',
    'dependency-review-config.yml',
    'codeql-config.yml',
    'required-checks.json',
  ]),
  optional: Object.freeze([]),
});

export const ROOT_FILES = Object.freeze([
  'CLAUDE.md',
  'README.md',
  'SECURITY.md',
  'LICENSE',
  'package.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  '.gitignore',
  '.editorconfig',
  '.nvmrc',
  '.node-version',
]);

export const WORKSPACE_GLOBS = Object.freeze(['apps/*', 'packages/*']);
export const NODE_ENGINE = '>=22 <23';
export const PNPM_PACKAGE_MANAGER = /^pnpm@9\.\d+\.\d+(\+[\w.-]+)?$/;

/** Entries ignored when comparing directory listings. */
const IGNORED_ENTRIES = new Set(['.gitkeep', '.DS_Store', '.bootstrap-report.json']);
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listEntries(dir) {
  return readdirSync(dir)
    .filter((entry) => !IGNORED_ENTRIES.has(entry))
    .sort();
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isDirectory(file) {
  return existsSync(file) && statSync(file).isDirectory();
}

/**
 * Reports entries that differ only by case (they collide on case-insensitive filesystems).
 * @param {string} rel
 * @param {string[]} entries
 * @param {string[]} errors
 */
function checkCaseCollisions(rel, entries, errors) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const entry of entries) {
    const key = entry.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) {
      errors.push(`${rel}: "${other}" and "${entry}" collide on case-insensitive filesystems`);
    } else {
      seen.set(key, entry);
    }
  }
}

/**
 * Compares a directory's children against an expected set.
 * @param {string} root
 * @param {string} rel
 * @param {readonly string[]} required
 * @param {readonly string[]} optional
 * @param {{ requireDirs: boolean, kebab: boolean }} opts
 * @param {string[]} errors
 * @returns {string[]} the entries present
 */
function checkDirectory(root, rel, required, optional, opts, errors) {
  const abs = path.join(root, rel);
  if (!isDirectory(abs)) {
    errors.push(`${rel}/: directory is missing`);
    return [];
  }
  const entries = listEntries(abs);
  checkCaseCollisions(rel, entries, errors);
  const allowed = new Set([...required, ...optional]);
  for (const entry of required) {
    if (!entries.includes(entry)) {
      errors.push(`${rel}/${entry}: missing (required by CONTEXT_PACK §6)`);
    }
  }
  for (const entry of entries) {
    if (!allowed.has(entry)) {
      errors.push(`${rel}/${entry}: unexpected entry (layout drift from CONTEXT_PACK §6)`);
    }
    if (opts.kebab && !KEBAB_CASE.test(entry) && isDirectory(path.join(abs, entry))) {
      errors.push(`${rel}/${entry}: directory names must be lowercase kebab-case`);
    }
    if (opts.requireDirs && required.includes(entry) && !isDirectory(path.join(abs, entry))) {
      errors.push(`${rel}/${entry}: must be a directory`);
    }
  }
  return entries;
}

/**
 * Parses the `packages:` list of a pnpm-workspace.yaml without a YAML dependency.
 * Supports the block-sequence form used in this repository.
 * @param {string} text
 * @returns {string[] | null} the globs, or null if no `packages:` key is found
 */
export function parseWorkspaceGlobs(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages:\s*(#.*)?$/.test(line));
  if (start === -1) return null;
  /** @type {string[]} */
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const match = /^\s+-\s+(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(#.*)?$/.exec(line);
    if (!match) break;
    globs.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return globs;
}

/**
 * @param {string} file
 * @param {string} rel
 * @param {string[]} errors
 * @returns {Record<string, unknown> | null}
 */
function readJson(file, rel, errors) {
  if (!existsSync(file)) {
    errors.push(`${rel}: missing`);
    return null;
  }
  try {
    /** @type {unknown} */
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${rel}: must contain a JSON object`);
      return null;
    }
    return /** @type {Record<string, unknown>} */ (value);
  } catch (error) {
    errors.push(`${rel}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

/**
 * @param {string} root
 * @param {string[]} errors
 */
function checkRootManifest(root, errors) {
  const manifest = readJson(path.join(root, 'package.json'), 'package.json', errors);
  if (manifest === null) return;
  if (manifest.private !== true) errors.push(`package.json: "private" must be true`);
  if (
    typeof manifest.packageManager !== 'string' ||
    !PNPM_PACKAGE_MANAGER.test(manifest.packageManager)
  ) {
    errors.push(`package.json: "packageManager" must pin a pnpm 9.x version (e.g. "pnpm@9.15.0")`);
  }
  const engines = /** @type {Record<string, unknown> | undefined} */ (manifest.engines);
  if (engines?.node !== NODE_ENGINE) {
    errors.push(`package.json: "engines.node" must be "${NODE_ENGINE}"`);
  }
  const scripts = /** @type {Record<string, unknown> | undefined} */ (manifest.scripts);
  if (
    typeof scripts?.preinstall !== 'string' ||
    !scripts.preinstall.includes('scripts/preinstall.mjs')
  ) {
    errors.push(`package.json: "scripts.preinstall" must run scripts/preinstall.mjs`);
  }
}

/**
 * @param {string} root
 * @param {string[]} errors
 */
function checkWorkspaceFile(root, errors) {
  const file = path.join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) return; // reported by the root-file check
  const globs = parseWorkspaceGlobs(readFileSync(file, 'utf8'));
  if (globs === null) {
    errors.push(`pnpm-workspace.yaml: no "packages:" list found`);
    return;
  }
  const expected = [...WORKSPACE_GLOBS].sort().join(', ');
  const actual = [...globs].sort().join(', ');
  if (expected !== actual) {
    errors.push(`pnpm-workspace.yaml: packages must be exactly [${expected}], found [${actual}]`);
  }
}

/**
 * @typedef {{ kind: "app" | "package", dir: string, name: string | null, version: string | null, private: boolean }} Member
 */

/**
 * Whether a module's source declares `export const <binding> = '<value>';`. Either quote style is
 * accepted: Prettier writes single quotes, generated stubs may use double quotes.
 * @param {string} source
 * @param {string} binding
 * @param {string} value
 * @returns {boolean}
 */
export function exportsConst(source, binding, value) {
  return ["'", '"'].some((quote) =>
    source.includes(`export const ${binding} = ${quote}${value}${quote};`),
  );
}

/**
 * @param {string} root
 * @param {"app" | "package"} kind
 * @param {string} dir  e.g. "apps/web"
 * @param {string[]} errors
 * @returns {Member}
 */
function checkMember(root, kind, dir, errors) {
  const base = path.basename(dir);
  const expectedName = `${SCOPE}/${base}`;
  /** @type {Member} */
  const member = { kind, dir, name: null, version: null, private: false };
  const manifest = readJson(path.join(root, dir, 'package.json'), `${dir}/package.json`, errors);
  if (manifest !== null) {
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      errors.push(`${dir}/package.json: "name" is missing (expected "${expectedName}")`);
    } else {
      member.name = manifest.name;
      if (manifest.name !== expectedName) {
        errors.push(
          `${dir}/package.json: "name" is "${manifest.name}", expected "${expectedName}"`,
        );
      }
    }
    if (typeof manifest.version === 'string') member.version = manifest.version;
    else errors.push(`${dir}/package.json: "version" is missing`);
    member.private = manifest.private === true;
    if (!member.private) {
      errors.push(`${dir}/package.json: "private" must be true (proprietary; never published)`);
    }
  }
  const index = path.join(root, dir, 'src', 'index.ts');
  if (!existsSync(index)) {
    errors.push(`${dir}/src/index.ts: missing`);
  } else if (!exportsConst(readFileSync(index, 'utf8'), 'name', expectedName)) {
    errors.push(`${dir}/src/index.ts: must export \`export const name = '${expectedName}';\``);
  }
  return member;
}

/**
 * @param {Member[]} members
 * @param {string[]} errors
 */
function checkDuplicateNames(members, errors) {
  /** @type {Map<string, string[]>} */
  const byName = new Map();
  for (const member of members) {
    if (member.name === null) continue;
    const dirs = byName.get(member.name) ?? [];
    dirs.push(member.dir);
    byName.set(member.name, dirs);
  }
  for (const [name, dirs] of byName) {
    if (dirs.length > 1) {
      errors.push(`duplicate package name "${name}" in: ${dirs.join(', ')}`);
    }
  }
}

/**
 * Checks `.github/`: the fixed directories and files exist with the right kind, and
 * nothing else is there.
 * @param {string} root
 * @param {string[]} errors
 */
function checkGithubDirectory(root, errors) {
  const required = [...GITHUB_LAYOUT.dirs, ...GITHUB_LAYOUT.files];
  const entries = checkDirectory(
    root,
    '.github',
    required,
    GITHUB_LAYOUT.optional,
    { requireDirs: false, kebab: false },
    errors,
  );
  for (const entry of entries) {
    const abs = path.join(root, '.github', entry);
    if (GITHUB_LAYOUT.dirs.includes(entry) && !isDirectory(abs)) {
      errors.push(`.github/${entry}: must be a directory`);
    }
    if (GITHUB_LAYOUT.files.includes(entry) && isDirectory(abs)) {
      errors.push(`.github/${entry}: must be a file`);
    }
  }
}

/**
 * Runs every layout check against `root`.
 * @param {string} root
 * @returns {{ ok: boolean, root: string, counts: { apps: number, packages: number }, members: Member[], errors: string[] }}
 */
export function checkLayout(root) {
  /** @type {string[]} */
  const errors = [];

  for (const file of ROOT_FILES) {
    if (!existsSync(path.join(root, file))) errors.push(`${file}: missing at repository root`);
  }
  checkRootManifest(root, errors);
  checkWorkspaceFile(root, errors);

  /** @type {Member[]} */
  const members = [];
  for (const [rel, kind, expected] of /** @type {const} */ ([
    ['apps', 'app', EXPECTED_APPS],
    ['packages', 'package', EXPECTED_PACKAGES],
  ])) {
    const entries = checkDirectory(
      root,
      rel,
      expected,
      [],
      { requireDirs: true, kebab: true },
      errors,
    );
    for (const entry of entries) {
      if (isDirectory(path.join(root, rel, entry))) {
        members.push(checkMember(root, kind, `${rel}/${entry}`, errors));
      }
    }
  }
  checkDuplicateNames(members, errors);

  /** @type {Readonly<Record<string, readonly string[]>>} */
  const dirFiles = EXPECTED_DIR_FILES;
  for (const [rel, expected] of Object.entries(EXPECTED_DIRS)) {
    const files = dirFiles[rel] ?? [];
    const entries = checkDirectory(
      root,
      rel,
      expected,
      files,
      { requireDirs: true, kebab: true },
      errors,
    );
    for (const file of files) {
      if (!entries.includes(file))
        errors.push(`${rel}/${file}: missing (required by CONTEXT_PACK §6)`);
      else if (isDirectory(path.join(root, rel, file)))
        errors.push(`${rel}/${file}: must be a file`);
    }
  }
  checkGithubDirectory(root, errors);

  return {
    ok: errors.length === 0,
    root,
    counts: {
      apps: members.filter((m) => m.kind === 'app').length,
      packages: members.filter((m) => m.kind === 'package').length,
    },
    members,
    errors,
  };
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, quiet: boolean }}
 */
function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet') quiet = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--root requires a directory argument');
      root = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root, quiet };
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `check-layout: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const result = checkLayout(args.root);
  if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(
      `check-layout: ${result.errors.length} problem(s) found (see CONTEXT_PACK §6):\n` +
        result.errors.map((e) => `  - ${e}`).join('\n') +
        '\n',
    );
    return 1;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
