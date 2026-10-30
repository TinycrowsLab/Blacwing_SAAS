import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { checkRepo, checkService, firstImportSpecifier } from './check-instrument-order.mjs';

describe('firstImportSpecifier', () => {
  it('returns the first import, skipping comments and blank lines', () => {
    assert.equal(
      firstImportSpecifier(
        "// header\n\n/* block */\nimport './instrument.js';\nimport x from 'y';",
      ),
      './instrument.js',
    );
  });

  it('handles type imports and multi-line named imports', () => {
    assert.equal(firstImportSpecifier("import type { A } from './a.js';"), './a.js');
    assert.equal(firstImportSpecifier("import {\n  a,\n  b,\n} from './b.js';"), './b.js');
  });

  it('returns null when a file has no import statement', () => {
    assert.equal(firstImportSpecifier('const x = 1;\n'), null);
  });

  it('ignores an import that appears only inside a comment', () => {
    assert.equal(firstImportSpecifier("// import './instrument.js';\nimport db from 'pg';"), 'pg');
  });
});

describe('instrument-order guard', () => {
  let root;
  const write = (rel, text) => {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'instrument-order-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes when the bootstrap is the first import of main.ts', () => {
    write('apps/api/src/instrument.ts', "import { initTelemetry } from '@blackwing/telemetry';\n");
    write(
      'apps/api/src/main.ts',
      "import './instrument.js';\n\nimport { runApi } from './run.js';\n",
    );
    assert.deepEqual(checkRepo(root), { checked: ['api'], failures: [] });
  });

  it('fails when a DB or framework import runs before the bootstrap', () => {
    write('apps/worker/src/instrument.ts', 'export {};\n');
    write('apps/worker/src/main.ts', "import { pool } from 'pg';\nimport './instrument.js';\n");
    const { failures } = checkRepo(root);
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /worker\/src\/main\.ts: first import must be '\.\/instrument\.js', found 'pg'/,
    );
  });

  it('fails when main.ts has no import at all', () => {
    write('apps/api/src/instrument.ts', 'export {};\n');
    write('apps/api/src/main.ts', 'process.exitCode = 0;\n');
    assert.match(checkService(path.join(root, 'apps/api'))[0], /found none/);
  });

  it('requires the Next.js hook to load the bootstrap dynamically', () => {
    write('apps/web/src/instrument.ts', 'export {};\n');
    write('apps/web/src/instrumentation.ts', 'export async function register() {}\n');
    assert.equal(checkService(path.join(root, 'apps/web'))[0].includes('dynamic import'), true);
    write(
      'apps/web/src/instrumentation.ts',
      "export async function register() { await import('./instrument.js'); }\n",
    );
    assert.deepEqual(checkService(path.join(root, 'apps/web')), []);
  });

  it('reports a service that has a bootstrap but no entrypoint', () => {
    write('apps/cli/src/instrument.ts', 'export {};\n');
    assert.match(
      checkService(path.join(root, 'apps/cli'))[0],
      /no main\.ts or instrumentation\.ts/,
    );
  });

  it('ignores services without a bootstrap', () => {
    write('apps/plain/src/main.ts', "import x from 'y';\n");
    assert.deepEqual(checkRepo(root), { checked: [], failures: [] });
  });
});
