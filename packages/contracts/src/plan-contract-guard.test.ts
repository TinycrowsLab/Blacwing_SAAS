// Guard (#427): the PLAN-owned oracle and negative-control contracts are declared exactly once under
// packages/contracts/src (oracles.ts, negative-control.ts). Consumers such as the planner contracts
// import them; a second declaration would let the planner's copy drift from the catalogue.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Every non-test `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The files under src that export `name` as a value, relative to src. */
function declaringFiles(name: string): string[] {
  const declaration = new RegExp(`^export (?:const|function|class) ${name}\\b`, 'm');
  return sourceFiles(SRC_DIR)
    .filter((file) => declaration.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC_DIR, file))
    .sort();
}

describe('PLAN oracle and negative-control contracts are declared once (#427)', () => {
  it.each([
    ['OracleSpecSchema', ['oracles.ts']],
    ['ORACLE_SPEC_TYPES', ['oracles.ts']],
    ['negativeControlSpecSchema', ['negative-control.ts']],
    ['NEGATIVE_CONTROL_KINDS', ['negative-control.ts']],
  ])('%s is declared only in its PLAN-owned module', (name, owners) => {
    expect(declaringFiles(name)).toEqual(owners);
  });
});
