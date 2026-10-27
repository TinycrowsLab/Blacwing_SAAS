// Integration test for the bw-sandbox image (IMAGE-001, #599). Needs Docker and network for the
// dependency fetch (or a pre-populated pnpm store). Run with `pnpm test:sandbox-image`; set
// BW_SANDBOX_BUILD_ARGS (e.g. "--network host") to pass extra `docker build` flags. Builds the
// image, then proves: uid 10001 with no root process, writes outside /workspace and /tmp fail with a
// read-only rootfs, the entrypoint starts under bw, and a missing tmpfs fails clearly.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
});
