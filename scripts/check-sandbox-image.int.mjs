// Integration test for the bw-sandbox image (IMAGE-001, #599). Needs Docker and network for the
// dependency fetch (or a pre-populated pnpm store). Run with `pnpm test:sandbox-image`; set
// BW_SANDBOX_BUILD_ARGS (e.g. "--network host") to pass extra `docker build` flags. Builds the
// image, then proves: uid 10001 with no root process, writes outside /workspace and /tmp fail with a
// read-only rootfs, the entrypoint starts under bw, a missing tmpfs fails clearly, the pinned
// ProjectDiscovery tools report their pinned versions and are root-owned, and install-tools.sh refuses a
// binary whose sha256 does not match the pin (the install-tools test downloads one release archive).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN_PATH = path.join(ROOT, 'infra/docker/sandbox/tools.pin.json');
const INSTALL_TOOLS = path.join(ROOT, 'infra/docker/sandbox/install-tools.sh');
/** @type {unknown} */
const rawPin = JSON.parse(readFileSync(PIN_PATH, 'utf8'));
const PIN = /** @type {{ tools: { name: string, version: string, sha256: string }[] }} */ (rawPin);
const PINNED_TOOLS = PIN.tools;
const SHA256_HEX_LENGTH = 64;
const TAG_ENTROPY_BYTES = 4;
const EX_CONFIG = 78;
const TAG = `bw-sandbox:int-${randomBytes(TAG_ENTROPY_BYTES).toString('hex')}`;
const HARDEN = [
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--tmpfs=/workspace:uid=10001,gid=10001',
  '--tmpfs=/tmp:uid=10001,gid=10001',
];
/** @param {string[]} args */
const docker = (args) => spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8' });
/** @param {string[]} cmd @param {string[]} [extra] */
const run = (cmd, extra = HARDEN) => docker(['run', '--rm', ...extra, TAG, ...cmd]);

describe('bw-sandbox image', { timeout: 600_000 }, () => {
  before(() => {
    const flags = process.env.BW_SANDBOX_BUILD_ARGS?.split(' ').filter(Boolean) ?? [];
    const b = docker([
      'build',
      '-q',
      '-f',
      'infra/docker/sandbox/Dockerfile',
      '-t',
      TAG,
      ...flags,
      '.',
    ]);
    assert.equal(b.status, 0, b.stderr);
  });
  after(() => {
    docker(['rmi', '-f', TAG]);
  });

  it('runs as uid 10001 and the image config user is bw', () => {
    assert.equal(run(['id', '-u']).stdout.trim(), '10001');
    assert.equal(
      docker(['image', 'inspect', TAG, '--format', '{{.Config.User}}']).stdout.trim(),
      'bw:bw',
    );
  });

  it('has no root processes', () => {
    const r = run([
      'sh',
      '-c',
      "for p in /proc/[0-9]*; do awk '/^Uid:/{print $2}' $p/status; done",
    ]);
    const uids = r.stdout.split('\n').filter(Boolean);
    assert.ok(uids.length > 0 && uids.every((u) => u === '10001'), r.stdout);
  });

  it('refuses writes outside /workspace and /tmp on a read-only rootfs', () => {
    for (const p of ['/etc/bw/x', '/opt/bw/tools/x', '/app/x', '/usr/x', '/x']) {
      assert.notEqual(run(['sh', '-c', `touch ${p}`]).status, 0, p);
    }
    assert.equal(run(['sh', '-c', 'touch /workspace/a /tmp/a']).status, 0);
  });

  it('starts the agent-runtime entrypoint under bw', () => {
    const js = "const m=await import('/app/src/index.ts');console.log(m.name,process.getuid())";
    const r = run(['node', '--input-type=module', '-e', js]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /agent-runtime 10001/);
  });

  it('fails clearly when /workspace is not a writable tmpfs', () => {
    const r = run(['true'], ['--read-only', '--cap-drop=ALL']);
    assert.equal(r.status, EX_CONFIG);
    assert.match(r.stderr, /\/workspace is not writable/);
  });

  it('provides the standard directories and env defaults', () => {
    const r = run([
      'sh',
      '-c',
      'ls -d /opt/bw/tools/bin /opt/bw/templates /opt/bw/wordlists /etc/bw >/dev/null && echo $BW_SANDBOX $NODE_ENV',
    ]);
    assert.equal(r.stdout.trim(), '1 production');
  });

  it('bakes in each pinned ProjectDiscovery tool at its pinned version', () => {
    for (const { name, version } of PINNED_TOOLS) {
      const r = run([name, '-version']);
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.ok(`${r.stdout}${r.stderr}`.includes(version), `${name} does not report ${version}`);
    }
  });

  it('keeps the pinned tools root-owned and not writable by bw', () => {
    // No --read-only here: a writable rootfs proves the directory permissions, not just the mount.
    const writable = [
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--tmpfs=/workspace:uid=10001,gid=10001',
    ];
    const stat = run(['stat', '-c', '%U %a', '/opt/bw/tools/bin/nuclei'], writable);
    assert.equal(stat.stdout.trim(), 'root 555');
    const replace = run(
      ['sh', '-c', 'touch /opt/bw/tools/bin/nuclei 2>/dev/null; touch /opt/bw/tools/bin/evil'],
      writable,
    );
    assert.notEqual(replace.status, 0);
  });
});

describe('install-tools.sh', { timeout: 600_000 }, () => {
  it('refuses to install a binary whose sha256 does not match the pin', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-tools-'));
    try {
      const pin = structuredClone(PIN);
      const subfinder = pin.tools.find((t) => t.name === 'subfinder');
      assert.ok(subfinder);
      // subfinder is first in the pin, so the mismatch is hit before any other archive is fetched.
      subfinder.sha256 = '0'.repeat(SHA256_HEX_LENGTH);
      const pinPath = path.join(dir, 'tools.pin.json');
      writeFileSync(pinPath, JSON.stringify(pin));
      const bin = path.join(dir, 'bin');
      const r = spawnSync('sh', [INSTALL_TOOLS, pinPath, bin], { encoding: 'utf8' });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /sha256 mismatch for subfinder/);
      assert.deepEqual(readdirSync(bin), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
