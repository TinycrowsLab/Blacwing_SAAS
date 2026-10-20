#!/usr/bin/env node
// Root `preinstall` guard. Fails `pnpm install` loudly (non-zero exit) when:
//   1. the install is driven by a package manager other than pnpm (same semantics as
//      the `only-allow pnpm` package, implemented in-repo so installs stay hermetic and
//      work offline);
//   2. Node.js is not version 22 (root `engines.node` is ">=22 <23");
//   3. the workspace layout drifts from CONTEXT_PACK §6 or has missing/duplicate
//      package names (scripts/check-layout.mjs) — pnpm itself only warns or ignores these.
//
// Uses only Node built-ins: it runs before any dependency is installed.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLayout } from './check-layout.mjs';

export const REQUIRED_PACKAGE_MANAGER = 'pnpm';
export const REQUIRED_NODE_MAJOR = 22;

/**
 * Mirrors `only-allow`: the package manager is read from `npm_config_user_agent`
 * (e.g. "pnpm/9.15.0 npm/? node/v22.22.1 linux x64"). When no user agent is set the
 * script was not started by a package manager and the check passes.
 * @param {string | undefined} userAgent
 * @returns {string | null} an error message, or null when allowed
 */
export function checkPackageManager(userAgent) {
  if (userAgent === undefined || userAgent.trim() === '') return null;
  const used = userAgent.trim().split(' ')[0]?.split('/')[0] ?? '';
  if (used === REQUIRED_PACKAGE_MANAGER) return null;
  return (
    `This repository must be installed with ${REQUIRED_PACKAGE_MANAGER}, not "${used}". ` +
    `Enable it with \`corepack enable\` and run \`pnpm install\`.`
  );
}

/**
 * @param {string} version  a Node.js version string such as "v22.22.1"
 * @returns {string | null} an error message, or null when allowed
 */
export function checkNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match)
    return `Unrecognised Node.js version "${version}"; Node.js ${REQUIRED_NODE_MAJOR} LTS is required.`;
  const major = Number(match[1]);
  if (major === REQUIRED_NODE_MAJOR) return null;
  return (
    `Node.js ${REQUIRED_NODE_MAJOR} LTS is required (engines.node ">=22 <23"), found ${version}. ` +
    `Use the version pinned in .nvmrc / .node-version.`
  );
}

/**
 * @param {{ userAgent: string | undefined, nodeVersion: string, root: string }} input
 * @returns {string[]} all problems found
 */
export function runPreinstallChecks({ userAgent, nodeVersion, root }) {
  /** @type {string[]} */
  const problems = [];
  const pm = checkPackageManager(userAgent);
  if (pm !== null) problems.push(pm);
  const node = checkNodeVersion(nodeVersion);
  if (node !== null) problems.push(node);
  const layout = checkLayout(root);
  for (const error of layout.errors) problems.push(`layout: ${error}`);
  return problems;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const problems = runPreinstallChecks({
    userAgent: process.env.npm_config_user_agent,
    nodeVersion: process.version,
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  });
  if (problems.length > 0) {
    process.stderr.write(
      `\npreinstall: refusing to install (${problems.length} problem(s)):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\n',
    );
    process.exitCode = 1;
  }
}
