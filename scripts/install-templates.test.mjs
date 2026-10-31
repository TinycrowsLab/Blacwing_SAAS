// Tests for the build-time nuclei-templates installer (IMAGE-004, #602). No network: the archive is served by a fake
// fetch from a locally built tarball, so the sha256 pin, the pruning and the tree digest are exercised for real.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  installTemplates,
  safeRel,
  listFiles,
  templatesPin,
  treeDigest,
} from '../infra/docker/sandbox/tools/install-templates.mjs';
import { sha256Hex } from '../infra/docker/sandbox/tools/install-tools.mjs';

const COMMIT = 'a'.repeat(40);
const TOP = 'nuclei-templates-test';
const KEEP = ['dns', 'helpers', 'http', 'network', 'ssl'];
const EXCLUDE = ['http/fuzzing', 'http/token-spray'];
/** Files the pruned tree must hold: every kept directory, minus the excluded paths. */
const KEPT_FILES = {
  'dns/d.yaml': 'id: d\n',
  'helpers/h.txt': 'helper\n',
  'http/cves/c.yaml': 'id: c\n',
  'network/n.yaml': 'id: n\n',
  'ssl/s.yaml': 'id: s\n',
};
/** Files an archive holds for the pinned exclusions (they must not survive the prune). */
const EXCLUDED_FILES = { 'http/fuzzing/f.yaml': 'id: f\n', 'http/token-spray/t.yaml': 'id: t\n' };
/** A full upstream archive: every kept file plus the excluded directories. */
const ARCHIVE_FILES = { ...KEPT_FILES, ...EXCLUDED_FILES };
/** Files the archive also holds that must not survive the prune. */
const STRAY_FILES = {
  'cloud/x.yaml': 'id: x\n',
  'http/fuzzing/f.yaml': 'id: f\n',
  'http/token-spray/t.yaml': 'id: t\n',
  'README.md': '# upstream\n',
  '.nuclei-ignore': 'tags: []\n',
};

/** @type {string} */
let root;
before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bw-install-templates-test-'));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Writes files under `dir`, creating parent directories.
 * @param {string} dir
 * @param {Record<string, string>} files
 */
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/**
 * Builds a GitHub-style source archive (one top-level directory) and returns its bytes.
 * @param {string} name
 * @param {{ files: Record<string, string>, links?: Record<string, string> }} spec
 * @returns {Uint8Array}
 */
function makeArchive(name, spec) {
  const src = path.join(root, `src-${name}`);
  const top = path.join(src, TOP);
  mkdirSync(top, { recursive: true });
  writeTree(top, spec.files);
  for (const [rel, target] of Object.entries(spec.links ?? {})) {
    mkdirSync(path.dirname(path.join(top, rel)), { recursive: true });
    symlinkSync(target, path.join(top, rel));
  }
  const out = path.join(root, `${name}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', src, TOP]);
  assert.equal(r.status, 0, String(r.stderr));
  return new Uint8Array(readFileSync(out));
}

/**
 * The digest the installer must compute for the pruned tree of the default fixture.
 * @returns {string}
 */
function expectedTreeDigest() {
  const dir = path.join(root, `expected-${Math.random().toString(36).slice(2)}`);
  writeTree(dir, KEPT_FILES);
  return treeDigest(dir);
}

/**
 * A tools.pin.json fragment that pins the given archive bytes and tree digest.
 * @param {Uint8Array} bytes
 * @param {Partial<{ treeSha256: string, keep: string[], exclude: string[], commit: string }>} [overrides]
 * @returns {{ templates: unknown[] }}
 */
function pinFor(bytes, overrides = {}) {
  const commit = overrides.commit ?? COMMIT;
  return {
    templates: [
      {
        name: 'nuclei-templates',
        version: '10.5.1',
        repo: 'https://github.com/projectdiscovery/nuclei-templates',
        commit,
        url: `https://github.com/projectdiscovery/nuclei-templates/archive/${commit}.tar.gz`,
        sha256: sha256Hex(bytes),
        treeSha256: overrides.treeSha256 ?? expectedTreeDigest(),
        licence: 'MIT',
        keep: overrides.keep ?? KEEP,
        exclude: overrides.exclude ?? EXCLUDE,
      },
    ],
  };
}

/**
 * @param {string} name
 * @param {unknown} pin
 * @returns {string} path of the written pin file
 */
function writePin(name, pin) {
  const file = path.join(root, `${name}.pin.json`);
  writeFileSync(file, JSON.stringify(pin));
  return file;
}

/**
 * @param {Uint8Array} bytes
 * @returns {() => Promise<Response>}
 */
const serve = (bytes) => () => Promise.resolve(new Response(bytes, { status: 200 }));

/**
 * @param {string} dir
 * @returns {string[]} sorted relative file paths under dir
 */
const relFiles = (dir) => listFiles(dir).map((f) => f.rel);

describe('installTemplates', () => {
  it('keeps only the pinned directories, prunes the excluded paths and writes the pin record', async () => {
    const bytes = makeArchive('ok', { files: { ...KEPT_FILES, ...STRAY_FILES } });
    const dest = path.join(root, 'ok', 'official');
    const result = await installTemplates(writePin('ok', pinFor(bytes)), dest, {
      fetchImpl: serve(bytes),
    });
    assert.deepEqual(relFiles(dest), ['.bw-template-pin.json', ...Object.keys(KEPT_FILES).sort()]);
    assert.equal(result.commit, COMMIT);
    assert.equal(result.files, Object.keys(KEPT_FILES).length);
    /** @type {unknown} */
    const parsed = JSON.parse(readFileSync(path.join(dest, '.bw-template-pin.json'), 'utf8'));
    const record = /** @type {Record<string, unknown>} */ (parsed);
    assert.deepEqual(record, {
      name: 'nuclei-templates',
      version: '10.5.1',
      commit: COMMIT,
      treeSha256: result.treeSha256,
    });
    assert.equal(result.treeSha256, expectedTreeDigest());
  });

  it('refuses an archive whose sha256 does not match the pin and leaves dest untouched', async () => {
    const bytes = makeArchive('good', { files: ARCHIVE_FILES });
    const tampered = makeArchive('tampered', { files: { ...ARCHIVE_FILES, 'dns/evil.yaml': 'x' } });
    const dest = path.join(root, 'mismatch', 'official');
    await assert.rejects(
      installTemplates(writePin('mismatch', pinFor(bytes)), dest, { fetchImpl: serve(tampered) }),
      /sha256 mismatch/,
    );
    assert.equal(existsSync(dest), false);
  });

  it('refuses a kept tree whose digest does not match the pinned treeSha256', async () => {
    const bytes = makeArchive('treemix', { files: ARCHIVE_FILES });
    const dest = path.join(root, 'treemix', 'official');
    const pin = pinFor(bytes, { treeSha256: 'b'.repeat(64) });
    await assert.rejects(
      installTemplates(writePin('treemix', pin), dest, { fetchImpl: serve(bytes) }),
      /tree: sha256 mismatch/,
    );
    assert.equal(existsSync(dest), false);
  });

  it('fails closed on a symlink inside a kept directory', async () => {
    const bytes = makeArchive('symlink', {
      files: ARCHIVE_FILES,
      links: { 'http/evil-link': '/etc/passwd' },
    });
    const dest = path.join(root, 'symlink', 'official');
    await assert.rejects(
      installTemplates(writePin('symlink', pinFor(bytes)), dest, { fetchImpl: serve(bytes) }),
      /symlinks are not allowed/,
    );
    assert.equal(existsSync(dest), false);
  });

  it('fails when a pinned kept directory is missing from the archive', async () => {
    const bytes = makeArchive('nokeep', { files: { 'dns/d.yaml': 'id: d\n' } });
    const dest = path.join(root, 'nokeep', 'official');
    await assert.rejects(
      installTemplates(writePin('nokeep', pinFor(bytes)), dest, { fetchImpl: serve(bytes) }),
      /archive has no kept directory helpers/,
    );
  });

  it('fails when a pinned exclusion is not in the archive, so a stale pin cannot shrink silently', async () => {
    const bytes = makeArchive('noexclude', { files: KEPT_FILES });
    const dest = path.join(root, 'noexclude', 'official');
    await assert.rejects(
      installTemplates(writePin('noexclude', pinFor(bytes)), dest, { fetchImpl: serve(bytes) }),
      /excluded path http\/fuzzing is not in the archive/,
    );
  });

  it('fails on an HTTP error from the archive host without writing dest', async () => {
    const bytes = makeArchive('http500', { files: ARCHIVE_FILES });
    const dest = path.join(root, 'http500', 'official');
    await assert.rejects(
      installTemplates(writePin('http500', pinFor(bytes)), dest, {
        fetchImpl: () => Promise.resolve(new Response('down', { status: 500 })),
      }),
      /HTTP 500/,
    );
    assert.equal(existsSync(dest), false);
  });

  it('replaces an existing dest with the new pinned tree', async () => {
    const bytes = makeArchive('replace', { files: ARCHIVE_FILES });
    const dest = path.join(root, 'replace', 'official');
    writeTree(dest, { 'stale/old.yaml': 'old\n' });
    await installTemplates(writePin('replace', pinFor(bytes)), dest, { fetchImpl: serve(bytes) });
    assert.equal(existsSync(path.join(dest, 'stale')), false);
    assert.ok(existsSync(path.join(dest, 'dns', 'd.yaml')));
  });
});

describe('templatesPin', () => {
  /** @returns {Record<string, unknown>} a valid entry to mutate */
  const valid = () =>
    /** @type {Record<string, unknown>} */ (pinFor(new Uint8Array([1, 2, 3])).templates[0]);
  /**
   * @param {(e: Record<string, unknown>) => void} mutate
   * @param {RegExp} pattern
   */
  const reject = (mutate, pattern) => {
    const entry = valid();
    mutate(entry);
    assert.throws(() => templatesPin({ templates: [entry] }), pattern);
  };

  it('accepts a complete pin', () => {
    const pin = templatesPin({ templates: [valid()] });
    assert.equal(pin.commit, COMMIT);
    assert.deepEqual(pin.keep, KEEP);
  });

  it('requires an entry named nuclei-templates', () => {
    assert.throws(() => templatesPin({ templates: [] }), /has no nuclei-templates entry/);
    assert.throws(() => templatesPin({}), /has no nuclei-templates entry/);
  });

  it('rejects a commit that is not a full 40-character SHA', () => {
    reject((e) => (e.commit = 'abc123'), /full 40-character SHA/);
  });

  it('rejects an archive URL that does not pin the same commit', () => {
    reject((e) => (e.url = `${String(e.repo)}/archive/main.tar.gz`), /must pin the archive/);
  });

  it('rejects a repository other than upstream nuclei-templates', () => {
    reject((e) => (e.repo = 'https://github.com/example/nuclei-templates'), /repo must be/);
  });

  it('rejects a malformed sha256 or treeSha256', () => {
    reject((e) => (e.sha256 = 'A'.repeat(64)), /sha256 must be 64/);
    reject((e) => (e.treeSha256 = 'z'.repeat(64)), /treeSha256 must be 64/);
  });

  it('rejects a licence other than MIT', () => {
    reject((e) => (e.licence = 'GPL-3.0-only'), /licence must be MIT/);
  });

  it('rejects a non-semver version', () => {
    reject((e) => (e.version = 'latest'), /exact semver/);
  });

  it('rejects an empty keep list and nested keep entries', () => {
    reject((e) => (e.keep = []), /keep must list/);
    reject((e) => (e.keep = ['http/cves']), /must be a top-level directory/);
    reject((e) => (e.keep = ['..']), /must be a top-level directory/);
  });

  it('rejects exclusions outside a kept directory or with traversal', () => {
    reject((e) => (e.exclude = ['cloud/aws']), /must sit under a kept directory/);
    reject((e) => (e.exclude = ['http/../../etc']), /must sit under a kept directory/);
    reject((e) => (e.exclude = ['http']), /must sit under a kept directory/);
  });
});

describe('safeRel', () => {
  it('accepts plain segments and refuses traversal, absolute and empty segments', () => {
    assert.equal(safeRel('http/cves/2021'), true);
    assert.equal(safeRel('../etc'), false);
    assert.equal(safeRel('/etc'), false);
    assert.equal(safeRel('http//x'), false);
    assert.equal(safeRel('http/./x'), false);
  });
});

describe('treeDigest', () => {
  it('is stable for the same bytes and changes when any byte changes', () => {
    const a = path.join(root, 'digest-a');
    const b = path.join(root, 'digest-b');
    writeTree(a, { 'x/a.yaml': 'one\n', 'y.yaml': 'two\n' });
    writeTree(b, { 'y.yaml': 'two\n', 'x/a.yaml': 'one\n' });
    assert.equal(treeDigest(a), treeDigest(b));
    writeFileSync(path.join(b, 'y.yaml'), 'TWO\n');
    assert.notEqual(treeDigest(a), treeDigest(b));
  });

  it('binds the file path, so a renamed file changes the digest', () => {
    const a = path.join(root, 'rename-a');
    const b = path.join(root, 'rename-b');
    writeTree(a, { 'http/one.yaml': 'same\n' });
    writeTree(b, { 'http/two.yaml': 'same\n' });
    assert.notEqual(treeDigest(a), treeDigest(b));
  });

  it('refuses symlinks, so the digest covers exactly the shipped bytes', () => {
    const dir = path.join(root, 'digest-link');
    writeTree(dir, { 'real.yaml': 'x\n' });
    symlinkSync('/etc/hostname', path.join(dir, 'link.yaml'));
    assert.throws(() => treeDigest(dir), /symlinks are not allowed/);
  });
});
