// Tests for the build-time sandbox toolchain installer (IMAGE-002, #601). No network: the downloads are
// served by a fake fetch from locally built tarballs, so the sha256 pins and the version probes are real.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  archiveFormat,
  assertDigest,
  fetchVerified,
  installTool,
  selectArtifact,
  sha256Hex,
} from '../infra/docker/sandbox/tools/install-tools.mjs';

/** @type {string} */
let root;
before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bw-install-tools-test-'));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** @param {string} name */
const dirFor = (name) => {
  const d = path.join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
};

/**
 * Builds a tar.gz with one executable named `member` that prints `output`.
 * @param {string} name
 * @param {string} member
 * @param {string} output
 * @returns {Uint8Array}
 */
function makeArchive(name, member, output) {
  const src = dirFor(`src-${name}`);
  writeFileSync(path.join(src, member), `#!/bin/sh\necho "${output}"\n`, { mode: 0o755 });
  const out = path.join(root, `${name}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', src, member]);
  assert.equal(r.status, 0, String(r.stderr));
  return new Uint8Array(readFileSync(out));
}

/**
 * Builds a tar.gz with a single top-level directory (like a GitHub source archive).
 * @param {string} name
 * @param {string} entry
 * @param {string} output
 * @returns {Uint8Array}
 */
function makeTree(name, entry, output) {
  const src = dirFor(`tree-${name}`);
  const top = path.join(src, `${name}-1.0`);
  mkdirSync(top, { recursive: true });
  writeFileSync(path.join(top, entry), `#!/bin/sh\necho "${output}"\n`, { mode: 0o755 });
  const out = path.join(root, `${name}-tree.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', src, `${name}-1.0`]);
  assert.equal(r.status, 0, String(r.stderr));
  return new Uint8Array(readFileSync(out));
}

/** @param {Uint8Array} bytes */
const fakeFetch = (bytes) => () => Promise.resolve(new Response(bytes, { status: 200 }));

describe('sha256 verification', () => {
  it('computes the hex sha256 of the bytes', () => {
    // sha256 of the empty input is a published test vector.
    assert.equal(
      sha256Hex(new Uint8Array()),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('accepts bytes that match the pin', () => {
    const bytes = new TextEncoder().encode('abc');
    assert.doesNotThrow(() => {
      assertDigest(bytes, sha256Hex(bytes), 'tool');
    });
  });

  it('fails closed on a mismatched digest (mutation: one byte changed)', () => {
    const bytes = new TextEncoder().encode('abc');
    const pinned = sha256Hex(bytes);
    const tampered = new TextEncoder().encode('abd');
    assert.throws(() => {
      assertDigest(tampered, pinned, 'tool');
    }, /sha256 mismatch/);
  });

  it('rejects a malformed pin instead of comparing against it', () => {
    assert.throws(() => {
      assertDigest(new Uint8Array(), 'NOTHEX', 'tool');
    }, /malformed/);
    assert.throws(() => {
      assertDigest(new Uint8Array(), 'A'.repeat(64), 'tool');
    }, /malformed/);
  });
});

describe('fetchVerified', () => {
  it('returns the bytes when the download matches the pin', async () => {
    const bytes = new TextEncoder().encode('payload');
    const got = await fetchVerified(
      'https://example.test/x',
      sha256Hex(bytes),
      'tool',
      fakeFetch(bytes),
    );
    assert.deepEqual(Buffer.from(got), Buffer.from(bytes));
  });

  it('retries a transient network failure, then verifies the bytes', async () => {
    const bytes = new TextEncoder().encode('payload');
    let calls = 0;
    const flaky = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(new Response(bytes, { status: 200 }));
    };
    const got = await fetchVerified('https://example.test/x', sha256Hex(bytes), 'tool', flaky);
    assert.equal(calls, 2);
    assert.deepEqual(Buffer.from(got), Buffer.from(bytes));
  });

  it('gives up after the last attempt instead of retrying forever', async () => {
    let calls = 0;
    const down = () => {
      calls += 1;
      return Promise.reject(new TypeError('fetch failed'));
    };
    await assert.rejects(
      fetchVerified('https://example.test/x', 'a'.repeat(64), 'tool', down),
      /tool: network error fetching https:\/\/example\.test\/x \(fetch failed\)/,
    );
    assert.equal(calls, 3);
  });

  it('throws on a checksum mismatch', async () => {
    const served = new TextEncoder().encode('tampered');
    const pinned = sha256Hex(new TextEncoder().encode('original'));
    await assert.rejects(
      fetchVerified('https://example.test/x', pinned, 'tool', fakeFetch(served)),
      /sha256 mismatch/,
    );
  });

  it('throws on an HTTP error instead of verifying an error page', async () => {
    const notFound = () => Promise.resolve(new Response('nope', { status: 404 }));
    await assert.rejects(
      fetchVerified('https://example.test/x', 'a'.repeat(64), 'tool', notFound),
      /HTTP 404/,
    );
  });
});

describe('selectArtifact', () => {
  const perArch = {
    name: 't',
    artifacts: {
      amd64: { url: 'https://example.test/a', sha256: 'a'.repeat(64) },
      arm64: { url: 'https://example.test/b', sha256: 'b'.repeat(64) },
    },
  };

  it('picks the artifact for the architecture', () => {
    assert.equal(selectArtifact(perArch, 'arm64').url, 'https://example.test/b');
  });

  it('uses the single source artifact for every architecture', () => {
    const src = {
      name: 't',
      artifacts: { all: { url: 'https://example.test/s', sha256: 'c'.repeat(64) } },
    };
    assert.equal(selectArtifact(src, 'amd64').url, 'https://example.test/s');
    assert.equal(selectArtifact(src, 'arm64').url, 'https://example.test/s');
  });

  it('refuses an architecture with no pinned artifact', () => {
    const amdOnly = {
      name: 't',
      artifacts: { amd64: { url: 'https://example.test/a', sha256: 'a'.repeat(64) } },
    };
    assert.throws(() => selectArtifact(amdOnly, 'arm64'), /no pinned artifact for arm64/);
  });
});

describe('archiveFormat', () => {
  it('unpacks tar.gz archives and treats anything else as a raw file', () => {
    assert.equal(archiveFormat('/x/ffuf_2.3.0_linux_amd64.tar.gz'), 'tar.gz');
    assert.equal(archiveFormat('/x/subfinder_2.17.0_linux_amd64.zip'), 'zip');
    assert.equal(archiveFormat('/x/jq-linux-amd64'), 'raw');
    assert.equal(archiveFormat('/x/opengrep_manylinux_x86'), 'raw');
  });
});

/**
 * @param {string} name
 * @param {Partial<{ kind: string, member: string, entry: string, shim: boolean }>} install
 * @param {Uint8Array} bytes
 * @param {string} version
 */
function pinFor(name, install, bytes, version) {
  return {
    name,
    version,
    licence: 'MIT',
    source: 'https://example.test/repo',
    entrypoint: name,
    versionArgs: ['--version'],
    install: { kind: 'archive', ...install },
    artifacts: { amd64: { url: `https://example.test/${name}.tar.gz`, sha256: sha256Hex(bytes) } },
  };
}

describe('installTool', () => {
  it('installs a verified archive member into bin and probes its version', async () => {
    const binDir = dirFor('ok-bin');
    const bytes = makeArchive('ffuf', 'ffuf', 'ffuf version 2.3.0');
    const tool = pinFor('ffuf', { member: 'ffuf' }, bytes, '2.3.0');
    const entry = await installTool(tool, {
      arch: 'amd64',
      workDir: dirFor('ok-work'),
      binDir,
      libDir: dirFor('ok-lib'),
      fetchImpl: fakeFetch(bytes),
    });
    assert.equal(entry.probe, 'ffuf version 2.3.0');
    assert.ok(existsSync(path.join(binDir, 'ffuf')));
  });

  it('leaves nothing installed when the download fails the pin (mutation: wrong sha256)', async () => {
    const binDir = dirFor('bad-bin');
    const bytes = makeArchive('bad', 'bad', 'bad version 1.0.0');
    const tool = {
      ...pinFor('bad', { member: 'bad' }, bytes, '1.0.0'),
      artifacts: { amd64: { url: 'https://example.test/bad.tar.gz', sha256: '0'.repeat(64) } },
    };
    await assert.rejects(
      installTool(tool, {
        arch: 'amd64',
        workDir: dirFor('bad-work'),
        binDir,
        libDir: dirFor('bad-lib'),
        fetchImpl: fakeFetch(bytes),
      }),
      /sha256 mismatch/,
    );
    assert.equal(existsSync(path.join(binDir, 'bad')), false);
  });

  it('fails the build when the binary does not report its pinned version', async () => {
    const bytes = makeArchive('stale', 'stale', 'stale version 0.1.0');
    const tool = pinFor('stale', { member: 'stale' }, bytes, '2.0.0');
    await assert.rejects(
      installTool(tool, {
        arch: 'amd64',
        workDir: dirFor('stale-work'),
        binDir: dirFor('stale-bin'),
        libDir: dirFor('stale-lib'),
        fetchImpl: fakeFetch(bytes),
      }),
      /did not report 2\.0\.0/,
    );
  });

  it('refuses an archive kind whose artifact is neither a tar.gz nor a zip', async () => {
    const raw = new TextEncoder().encode('#!/bin/sh\necho x\n');
    const tool = {
      name: 'raw',
      version: '1',
      licence: 'MIT',
      source: 'https://example.test/r',
      entrypoint: 'raw',
      versionArgs: [],
      install: { kind: 'archive', member: 'raw' },
      artifacts: { amd64: { url: 'https://example.test/raw-binary', sha256: sha256Hex(raw) } },
    };
    await assert.rejects(
      installTool(tool, {
        arch: 'amd64',
        workDir: dirFor('raw-work'),
        binDir: dirFor('raw-bin'),
        libDir: dirFor('raw-lib'),
        fetchImpl: fakeFetch(raw),
      }),
      /archive kind needs a tar.gz or zip artifact/,
    );
  });

  it('installs a source tree behind a PATH shim for testssl.sh-style tools', async () => {
    const binDir = dirFor('tree-bin');
    const libDir = dirFor('tree-lib');
    const bytes = makeTree('testssl', 'testssl.sh', 'testssl.sh version 3.2.4');
    const tool = {
      name: 'testssl.sh',
      version: '3.2.4',
      licence: 'GPL-2.0-only',
      source: 'https://example.test/testssl',
      entrypoint: 'testssl.sh',
      versionArgs: ['--version'],
      install: { kind: 'tree', entry: 'testssl.sh', shim: true },
      artifacts: { all: { url: 'https://example.test/testssl.tar.gz', sha256: sha256Hex(bytes) } },
    };
    const entry = await installTool(tool, {
      arch: 'arm64',
      workDir: dirFor('tree-work'),
      binDir,
      libDir,
      fetchImpl: fakeFetch(bytes),
    });
    assert.equal(entry.probe, 'testssl.sh version 3.2.4');
    assert.ok(existsSync(path.join(libDir, 'testssl.sh', 'testssl.sh')));
  });

  it('installs a tree without a shim so the raw tool is never on PATH (sqlmap)', async () => {
    const binDir = dirFor('sqlmap-bin');
    const libDir = dirFor('sqlmap-lib');
    const bytes = makeTree('sqlmap', 'sqlmap.py', 'sqlmap/1.9.9#stable');
    const tool = {
      name: 'sqlmap',
      version: '1.9.9',
      licence: 'GPL-2.0-only',
      source: 'https://example.test/sqlmap',
      entrypoint: 'bw-sqlmap',
      versionArgs: ['--version'],
      install: { kind: 'tree', entry: 'sqlmap.py', shim: false },
      artifacts: { all: { url: 'https://example.test/sqlmap.tar.gz', sha256: sha256Hex(bytes) } },
    };
    const entry = await installTool(tool, {
      arch: 'amd64',
      workDir: dirFor('sqlmap-work'),
      binDir,
      libDir,
      fetchImpl: fakeFetch(bytes),
    });
    assert.equal(entry.probe, 'wrapper-only');
    assert.ok(existsSync(path.join(libDir, 'sqlmap', 'sqlmap.py')));
    assert.equal(existsSync(path.join(binDir, 'sqlmap')), false);
    assert.equal(existsSync(path.join(binDir, 'bw-sqlmap')), false);
  });

  it('rejects a go install whose zipHash is malformed, before anything runs', async () => {
    const tool = {
      name: 'fingerprintx',
      version: '1.1.19',
      licence: 'Apache-2.0',
      source: 'https://example.test/fx',
      entrypoint: 'fingerprintx',
      versionArgs: [],
      install: {
        kind: 'go',
        module: 'example.test/fx',
        package: 'example.test/fx/cmd/fx',
        zipHash: 'sha256:xyz',
      },
    };
    await assert.rejects(
      installTool(tool, {
        arch: 'amd64',
        workDir: dirFor('go-work'),
        binDir: dirFor('go-bin'),
        libDir: dirFor('go-lib'),
      }),
      /zipHash is malformed/,
    );
  });
});
