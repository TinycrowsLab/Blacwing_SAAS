// Self-test for the knip gate (FOUND-018, #20): a fixture workspace proves an unused export is reported,
// generated code is not flagged, and the real tree is clean under the CI gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = readFileSync(join(root, 'knip.jsonc'), 'utf8');
const knipBin = join(root, 'node_modules', '.bin', 'knip');

/** @param {string} cwd @param {string[]} args */
function runKnip(cwd, args) {
  return spawnSync(knipBin, args, { cwd, encoding: 'utf8' });
}

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'knip-fixture-'));
  dirs.push(dir);
  const pkg = join(dir, 'packages', 'demo');
  mkdirSync(join(pkg, 'src', 'generated'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fx', private: true, type: 'module' }),
  );
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(dir, 'knip.jsonc'), config);
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@blackwing/demo',
      version: '0.0.0',
      type: 'module',
      exports: { '.': './src/index.ts' },
    }),
  );
  writeFileSync(join(pkg, 'src', 'index.ts'), "export { used } from './used.ts';\n");
  writeFileSync(
    join(pkg, 'src', 'used.ts'),
    'export const used = 1;\nexport const unusedExport = 2;\n',
  );
  // Generated output nobody imports: must never be reported.
  writeFileSync(join(pkg, 'src', 'generated', 'client.ts'), 'export const generatedClient = 1;\n');
  return dir;
}

describe('knip gate', () => {
  it('reports an intentionally unused export and does not flag generated code', () => {
    const res = runKnip(makeFixture(), ['--no-progress', '--reporter', 'json']);
    /** @type {unknown} */
    const raw = JSON.parse(res.stdout);
    const out = /** @type {{ issues: { exports?: { name: string }[] }[] }} */ (raw);
    const issues = out.issues.flatMap((i) => (i.exports ?? []).map((e) => e.name));
    assert.notEqual(res.status, 0, 'knip must fail when an unused export exists');
    assert.ok(
      issues.includes('unusedExport'),
      `expected unusedExport, got ${JSON.stringify(issues)}`,
    );
    assert.ok(!JSON.stringify(out).includes('generated'), 'generated code must not be flagged');
  });

  it('passes the CI gate (--max-issues=0) on the real tree', () => {
    const res = runKnip(root, ['--max-issues=0', '--no-progress']);
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });
});
