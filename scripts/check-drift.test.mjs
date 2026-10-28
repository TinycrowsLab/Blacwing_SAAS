// Tests for the drift checks (CI-015, #149): a fixture git repo per drift type.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  MIGRATIONS_DIR,
  applyMigrations,
  editedMigrations,
  main,
  staleArtifacts,
} from './check-drift.mjs';

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
};
/**
 * @param {string} root
 * @param {string} rel
 * @param {string} text
 */
const put = (root, rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-drift-'));
  dirs.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  put(root, 'apps/api/openapi/openapi.json', '{"openapi":"3.1.0"}\n');
  put(root, 'apps/api/schema.gql', 'type Query { ok: Boolean }\n');
  put(root, `${MIGRATIONS_DIR}/0000_init.sql`, 'create table t (id int);\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  git(root, ['checkout', '-qb', 'pr']);
  return root;
}

/** @param {() => number} fn */
const quiet = (fn) => {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return fn();
  } finally {
    process.stderr.write = write;
  }
};

describe('stale generated artifacts', () => {
  it('passes on a clean tree', () => {
    assert.equal(main(['stale'], fixture()), 0);
  });

  it('fails when OpenAPI is regenerated differently (Zod edited, spec not committed)', () => {
    const root = fixture();
    put(root, 'apps/api/openapi/openapi.json', '{"openapi":"3.1.0","paths":{}}\n');
    assert.equal(
      quiet(() => main(['stale'], root)),
      1,
    );
    const [msg] = staleArtifacts(' M apps/api/openapi/openapi.json\n');
    assert.match(msg ?? '', /OpenAPI.*pnpm openapi:generate/);
  });

  it('fails for a stale GraphQL SDL', () => {
    const root = fixture();
    put(root, 'apps/api/schema.gql', 'type Query { ok: Int }\n');
    assert.equal(
      quiet(() => main(['stale'], root)),
      1,
    );
  });

  it('fails when drizzle-kit would emit a new migration (schema without migration)', () => {
    const root = fixture();
    put(root, `${MIGRATIONS_DIR}/0001_new.sql`, 'alter table t add column x int;\n');
    assert.equal(
      quiet(() => main(['stale'], root)),
      1,
    );
    assert.match(staleArtifacts(`?? ${MIGRATIONS_DIR}/0001_new.sql\n`).join(), /db:generate/);
  });
});

describe('forward-only migrations', () => {
  it('allows adding a migration', () => {
    const root = fixture();
    put(root, `${MIGRATIONS_DIR}/0001_add.sql`, 'select 1;\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'add']);
    assert.equal(main(['immutable', 'main'], root), 0);
  });

  it('fails when an applied migration is edited', () => {
    const root = fixture();
    put(root, `${MIGRATIONS_DIR}/0000_init.sql`, 'create table t (id bigint);\n');
    git(root, ['commit', '-qam', 'edit']);
    assert.equal(
      quiet(() => main(['immutable', 'main'], root)),
      1,
    );
  });

  it('fails when an applied migration is deleted', () => {
    assert.equal(editedMigrations(`D\t${MIGRATIONS_DIR}/0000_init.sql\n`).length, 1);
  });

  it('ignores the drizzle journal and non-migration files', () => {
    const out = `M\t${MIGRATIONS_DIR}/meta/_journal.json\nM\tapps/api/src/x.ts\n`;
    assert.deepEqual(editedMigrations(out), []);
  });

  it('exempts an explicit squash', () => {
    const out = `D\t${MIGRATIONS_DIR}/0000_init.sql\n`;
    assert.deepEqual(editedMigrations(out, { allowSquash: true }), []);
  });
});

describe('migration apply', () => {
  /** @param {string} body */
  const fakePsql = (body) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-psql-'));
    dirs.push(dir);
    const bin = path.join(dir, 'psql');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  };

  it('applies migrations in order with ON_ERROR_STOP and passes when psql succeeds', () => {
    const root = fixture();
    put(root, `${MIGRATIONS_DIR}/0001_add.sql`, 'select 1;\n');
    const log = path.join(root, 'applied.log');
    const bin = fakePsql(`echo "$*" >> ${log}`);
    assert.deepEqual(applyMigrations(root, 'postgres://x/y', bin), []);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /0000_init\.sql/);
    assert.match(lines[1] ?? '', /ON_ERROR_STOP=1/);
  });

  it('stops at the first failing migration and names it', () => {
    const root = fixture();
    put(root, `${MIGRATIONS_DIR}/0001_add.sql`, 'select 1;\n');
    const bin = fakePsql('echo boom >&2; exit 3');
    const errors = applyMigrations(root, 'postgres://x/y', bin);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /0000_init\.sql failed to apply: boom/);
  });
});

describe('drift workflow contract', () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const workflow = readFileSync(path.join(repo, '.github/workflows/drift.yml'), 'utf8');

  it('pins timezone and locale, and only reads the repository', () => {
    assert.match(workflow, /^ {2}TZ: UTC$/m);
    assert.match(workflow, /^ {2}LANG: C\.UTF-8$/m);
    assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  });

  it('formats generated files with Prettier and tolerates artifacts that do not exist yet', () => {
    assert.match(workflow, /prettier --write --ignore-unknown --no-error-on-unmatched-pattern/);
  });

  it('exempts squashes only through the catalogued migration-squash label', () => {
    assert.match(workflow, /'migration-squash'/);
    const labels = readFileSync(path.join(repo, '.github/labels.yml'), 'utf8');
    assert.match(labels, /name: 'migration-squash'/);
  });
});
