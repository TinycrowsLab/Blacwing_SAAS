#!/usr/bin/env node
// Verifies the OBS-002 import-order rule (#299, docs/architecture/observability.md): in every TypeScript
// service that has a src/instrument.ts bootstrap, the first import statement of src/main.ts is
// './instrument.js', so the OpenTelemetry auto-instrumentations patch their libraries before anything loads
// them. The Next.js web app has no main.ts; its src/instrumentation.ts must load './instrument.js' with a
// dynamic import (the Node-runtime hook).
//
// Usage: node scripts/check-instrument-order.mjs [--root <dir>] [--quiet]
// Prints a JSON summary on stdout; exits non-zero when any check fails.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOOTSTRAP = './instrument.js';
const ENTRY_FILES = ['main.ts', 'instrumentation.ts'];

/** The module specifier of the first import statement in `source`, skipping comments; null when there is none. */
export function firstImportSpecifier(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const match = /^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/m.exec(code);
  return match?.[1] ?? null;
}

/** Problems for one service directory (`appDir/src`), or an empty list when it follows the rule. */
export function checkService(appDir) {
  const src = path.join(appDir, 'src');
  const name = path.basename(appDir);
  if (!existsSync(path.join(src, 'instrument.ts'))) return [];
  if (existsSync(path.join(src, 'main.ts'))) {
    const specifier = firstImportSpecifier(readFileSync(path.join(src, 'main.ts'), 'utf8'));
    if (specifier === BOOTSTRAP) return [];
    return [
      `${name}/src/main.ts: first import must be '${BOOTSTRAP}', found ${specifier === null ? 'none' : `'${specifier}'`}`,
    ];
  }
  if (existsSync(path.join(src, 'instrumentation.ts'))) {
    const hook = readFileSync(path.join(src, 'instrumentation.ts'), 'utf8');
    if (hook.includes(`import('${BOOTSTRAP}')`)) return [];
    return [`${name}/src/instrumentation.ts: must load '${BOOTSTRAP}' with a dynamic import`];
  }
  return [`${name}: src/instrument.ts has no main.ts or instrumentation.ts entrypoint`];
}

/** Runs the check over every apps/* member under `root`. */
export function checkRepo(root) {
  const appsDir = path.join(root, 'apps');
  const services = readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(appsDir, entry.name));
  const checked = services.filter((dir) => existsSync(path.join(dir, 'src', 'instrument.ts')));
  const failures = checked.flatMap(checkService);
  return { checked: checked.map((dir) => path.basename(dir)), failures };
}

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root =
    rootIndex === -1
      ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
      : path.resolve(argv[rootIndex + 1] ?? '.');
  const summary = checkRepo(root);
  if (!argv.includes('--quiet') || summary.failures.length > 0) {
    process.stdout.write(
      `${JSON.stringify({ ok: summary.failures.length === 0, ...summary }, null, 2)}\n`,
    );
  }
  return summary.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
