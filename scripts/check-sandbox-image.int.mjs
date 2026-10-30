// Integration test for the bw-sandbox image (IMAGE-001, #599; pinned toolchain IMAGE-002, #600 and #601). Needs
// Docker and network for the dependency fetch (or a pre-populated pnpm store). Run with `pnpm test:sandbox-image`;
// set BW_SANDBOX_BUILD_ARGS (e.g. "--network host") to pass extra `docker build` flags. Builds the image, then
// proves: uid 10001 with no root process, writes outside /workspace and /tmp fail with a read-only rootfs, the
// entrypoint starts under bw, a missing tmpfs fails clearly, every pinned tool reports its pinned version, the pinned
// tools are root-owned and read-only for bw, and the installers refuse a binary whose sha256 does not match its pin
// (the installer tests download one release archive each). The pinned headless browser (IMAGE-005, #603) launches
// with no network, its fonts are at their pinned versions, and its directory is root-owned and not writable by bw.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parses JSON text. The result is `unknown`, so callers must narrow it with a cast before use.
 * @param {string} text
 * @returns {unknown}
 */
const parseJson = (text) => JSON.parse(text);
/**
 * @typedef {{
 *   tools: { name: string, version: string, entrypoint: string, versionArgs: string[] }[],
 *   system: { name: string, version: string }[]
 * }} PinSubset
 */
const SCANNER_PIN_PATH = path.join(ROOT, 'infra/docker/sandbox/scanners.pin.json');
const PD_PIN_PATH = path.join(ROOT, 'infra/docker/sandbox/tools.pin.json');
const INSTALL_TOOLS = path.join(ROOT, 'infra/docker/sandbox/tools/install-tools.mjs');
const INSTALL_TOOLS_SH = path.join(ROOT, 'infra/docker/sandbox/install-tools.sh');
/** The pinned Chromium build, fonts and the root-owned browser directory (IMAGE-005, #603). */
const BROWSERS_PATH = '/opt/bw/browsers';
const PLAYWRIGHT_INDEX = '/app/node_modules/playwright-core/index.mjs';
/** The same headless launch as install-browser.sh: prints the Chromium version, exits 1 on a mismatch. */
const LAUNCH_JS = `const { chromium } = await import(process.argv[1]);
const browser = await chromium.launch({ headless: true });
const version = browser.version();
await browser.close();
console.log(version);
if (version !== process.argv[2]) process.exit(1);`;
/** @type {unknown} */
const rawBrowserPin = parseJson(readFileSync(PD_PIN_PATH, 'utf8'));
const BROWSER_VERSION = /** @type {{ browser: { chromium: { version: string } } }} */ (
  rawBrowserPin
).browser.chromium.version;
const PINNED_FONTS = /** @type {{ fonts: { package: string, version: string }[] }} */ (
  rawBrowserPin
).fonts;
const SHA256_HEX_LENGTH = 64;
const TAG_ENTROPY_BYTES = 4;
const EX_CONFIG = 78;
const EX_USAGE = 64;
const TAG = `bw-sandbox:int-${randomBytes(TAG_ENTROPY_BYTES).toString('hex')}`;
const HARDEN = [
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--tmpfs=/workspace:uid=10001,gid=10001',
  '--tmpfs=/tmp:uid=10001,gid=10001',
];
/**
 * opengrep extracts and runs its engine under $HOME, which the sandbox's noexec scratch mounts refuse ("couldn't
 * launch child"). Its version probe therefore runs with an exec-capable /tmp and HOME=/tmp. This is a known gap for
 * the scanner runtime (see the #601 summary); the image itself and HARDEN are unchanged.
 */
const EXEC_TMP_PROBE = [
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--tmpfs=/workspace:uid=10001,gid=10001',
  '--tmpfs=/tmp:uid=10001,gid=10001,exec',
  '-e',
  'HOME=/tmp',
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
  it('ships every pinned tool at its pinned version (manifest and version probe)', () => {
    const pins = /** @type {PinSubset} */ (
      /** @type {unknown} */ (parseJson(readFileSync(SCANNER_PIN_PATH, 'utf8')))
    );
    const manifest = /** @type {{ tools: { name: string, version: string }[] }} */ (
      /** @type {unknown} */ (parseJson(run(['cat', '/opt/bw/tools/manifest.json']).stdout))
    );
    for (const tool of pins.tools) {
      const row = manifest.tools.find((t) => t.name === tool.name);
      assert.equal(row?.version, tool.version, `manifest version for ${tool.name}`);
      if (tool.versionArgs.length === 0) continue;
      const entrypoint = tool.entrypoint;
      const r = run(
        [entrypoint, ...tool.versionArgs],
        tool.name === 'opengrep' ? EXEC_TMP_PROBE : HARDEN,
      );
      assert.equal(r.status, 0, `${entrypoint}: ${r.stderr}`);
      assert.ok(
        `${r.stdout}${r.stderr}`.includes(tool.version),
        `${entrypoint} does not report ${tool.version}`,
      );
    }
  });

  it('bakes in each pinned ProjectDiscovery tool at its pinned version', () => {
    const pd = /** @type {{ tools: { name: string, version: string }[] }} */ (
      /** @type {unknown} */ (parseJson(readFileSync(PD_PIN_PATH, 'utf8')))
    );
    for (const { name, version } of pd.tools) {
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

  it('keeps nmap and semgrep out of the image (licence review gate)', () => {
    const r = run([
      'sh',
      '-c',
      '! command -v nmap && ! command -v semgrep && test -z "$(find /opt/bw /usr/bin /usr/local/bin -name nmap -o -name "semgrep*" 2>/dev/null)"',
    ]);
    assert.equal(r.status, 0, r.stdout);
  });

  it('exposes sqlmap only through bw-sqlmap (raw sqlmap is not on PATH)', () => {
    assert.notEqual(run(['sh', '-c', 'command -v sqlmap']).status, 0);
    assert.equal(
      run(['sh', '-c', 'command -v bw-sqlmap']).stdout.trim(),
      '/opt/bw/tools/bin/bw-sqlmap',
    );
    assert.equal(run(['sh', '-c', 'test -e /opt/bw/tools/bin/sqlmap']).status, 1);
  });

  it('refuses destructive sqlmap options before the raw tool starts', () => {
    const r = run(['bw-sqlmap', '-u', 'https://app.example.test/', '--os-shell']);
    assert.equal(r.status, EX_USAGE, r.stdout);
    assert.match(r.stderr, /refused --os-shell/);
  });

  it('runs the real sqlmap through bw-sqlmap with safe defaults', () => {
    const r = run(['bw-sqlmap', '--version']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1\.9\.9/);
  });

  it('keeps the toolchain root-owned, so the sandbox user cannot replace a tool', () => {
    const r = run([
      'sh',
      '-c',
      'stat -c %u /opt/bw/tools/bin/ffuf /opt/bw/tools/bin/bw-sqlmap /opt/bw/tools/lib/sqlmap',
    ]);
    assert.deepEqual(r.stdout.trim().split('\n'), ['0', '0', '0']);
  });

  it('records the base-image python3, bash and openssl versions the tools depend on', () => {
    const pins = /** @type {PinSubset} */ (
      /** @type {unknown} */ (parseJson(readFileSync(SCANNER_PIN_PATH, 'utf8')))
    );
    const py = run([
      'python3',
      '-c',
      'import sys; print(".".join(map(str, sys.version_info[:3])))',
    ]);
    assert.equal(py.stdout.trim(), pins.system.find((s) => s.name === 'python3')?.version);
    const ssl = run(['openssl', 'version']);
    assert.ok(ssl.stdout.includes(String(pins.system.find((s) => s.name === 'openssl')?.version)));
    assert.equal(run(['bash', '--version']).status, 0);
  });

  it('launches the pinned headless Chromium with no network and no runtime download', () => {
    const r = run(
      [
        'node',
        '--input-type=module',
        '-e',
        LAUNCH_JS,
        `file://${PLAYWRIGHT_INDEX}`,
        BROWSER_VERSION,
      ],
      [...HARDEN, '--network=none'],
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), BROWSER_VERSION);
  });

  it('installs the pinned font packages at their pinned versions', () => {
    const names = PINNED_FONTS.map((f) => f.package);
    const r = run(
      ['dpkg-query', '-W', '-f=${Package}=${Version}\\n', ...names],
      ['--cap-drop=ALL', '--security-opt=no-new-privileges'],
    );
    assert.equal(r.status, 0, r.stderr);
    const installed = new Set(r.stdout.split('\n').filter(Boolean));
    for (const { package: name, version } of PINNED_FONTS) {
      assert.ok(installed.has(`${name}=${version}`), `${name} is not ${version}`);
    }
  });

  it('keeps the browser root-owned and not writable by bw', () => {
    // No --read-only here: a writable rootfs proves the directory permissions, not just the mount.
    const writable = [
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--tmpfs=/workspace:uid=10001,gid=10001',
    ];
    assert.equal(run(['stat', '-c', '%U', BROWSERS_PATH], writable).stdout.trim(), 'root');
    const write = run(
      ['sh', '-c', `touch ${BROWSERS_PATH}/evil 2>/dev/null; touch ${BROWSERS_PATH}/evil`],
      writable,
    );
    assert.notEqual(write.status, 0);
  });
});

describe('install-tools', { timeout: 600_000 }, () => {
  it('install-tools.sh refuses to install a binary whose sha256 does not match the pin', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-tools-'));
    try {
      /** @type {{ tools: { name: string, sha256: string }[] }} */
      const pin = structuredClone(
        /** @type {{ tools: { name: string, sha256: string }[] }} */ (
          /** @type {unknown} */ (parseJson(readFileSync(PD_PIN_PATH, 'utf8')))
        ),
      );
      // subfinder is first in the PD pin, so the mismatch is hit before any other archive is fetched.
      const subfinder = pin.tools.find((t) => t.name === 'subfinder');
      assert.ok(subfinder);
      subfinder.sha256 = '0'.repeat(SHA256_HEX_LENGTH);
      const pinPath = path.join(dir, 'tools.pin.json');
      writeFileSync(pinPath, JSON.stringify(pin));
      const bin = path.join(dir, 'bin');
      const r = spawnSync('sh', [INSTALL_TOOLS_SH, pinPath, bin], { encoding: 'utf8' });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /sha256 mismatch for subfinder/);
      assert.deepEqual(readdirSync(bin), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('install-tools.mjs refuses to install a scanner whose sha256 does not match its pin', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-scanners-'));
    try {
      /** @type {{ binDir: string, libDir: string, tools: { name: string, artifacts?: Record<string, { sha256: string }> }[] }} */
      const pin = structuredClone(
        /** @type {{ binDir: string, libDir: string, tools: { name: string, artifacts?: Record<string, { sha256: string }> }[] }} */ (
          /** @type {unknown} */ (parseJson(readFileSync(SCANNER_PIN_PATH, 'utf8')))
        ),
      );
      // ffuf is the first archive in the scanner pin, so the mismatch is hit before any Go build or other download.
      const ffuf = pin.tools.find((t) => t.name === 'ffuf');
      assert.ok(ffuf?.artifacts);
      for (const artifact of Object.values(ffuf.artifacts))
        artifact.sha256 = '0'.repeat(SHA256_HEX_LENGTH);
      pin.binDir = path.join(dir, 'bin');
      pin.libDir = path.join(dir, 'lib');
      const pinPath = path.join(dir, 'scanners.pin.json');
      writeFileSync(pinPath, JSON.stringify(pin));
      const r = spawnSync('node', [INSTALL_TOOLS, pinPath, path.dirname(INSTALL_TOOLS)], {
        encoding: 'utf8',
      });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /ffuf 2\.3\.0: sha256 mismatch/);
      assert.equal(existsSync(pin.binDir) ? readdirSync(pin.binDir).length : 0, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
