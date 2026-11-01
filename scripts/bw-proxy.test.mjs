// Tests for the bw-proxy wrapper (IMAGE-007, #605). The unit suite drives the real shell script against a fake
// proxychains launcher, so it needs no network. The integration suite runs the real proxychains-ng against a stub
// SOCKS5 gateway and proves routing, proxy-side DNS and fail-closed behaviour. It runs when proxychains-ng is
// installed (the image path, or BW_PROXYCHAINS_HOME pointing at a local build).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ conf: string, confPath: string, mode: string, argv: string[], preload: string | null }} LauncherRecord
 * @typedef {{ atyp: number, host: string, port: number }} SocksRequest
 * @typedef {{ port: number, hits: () => number, close: () => Promise<void> }} Target
 * @typedef {{ port: number, requests: SocksRequest[], close: () => Promise<void> }} Gateway
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = path.join(root, 'infra/docker/sandbox/tools/bw-proxy.sh');
const TEMPLATE = path.join(root, 'infra/docker/sandbox/proxy/proxychains.conf.template');
const BUILD = path.join(root, 'infra/docker/sandbox/proxy/build-proxychains.sh');
const PIN = path.join(root, 'infra/docker/sandbox/tools.pin.json');

const scratch = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'bw-proxy-test-'));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Copies the wrapper into a private dir with its install-time paths rewritten.
 * @param {string} pcHome directory holding bin/proxychains4
 * @returns {string} path to the rewritten wrapper
 */
function wrapperFor(pcHome) {
  const dir = mkdtempSync(path.join(scratch, 'w-'));
  const dst = path.join(dir, 'bw-proxy');
  const src = readFileSync(WRAPPER, 'utf8')
    .replace(/^PC_HOME=.*$/m, `PC_HOME=${pcHome}`)
    .replace(/^TEMPLATE=.*$/m, `TEMPLATE=${TEMPLATE}`);
  writeFileSync(dst, src);
  chmodSync(dst, 0o755);
  return dst;
}

/**
 * Fake proxychains4: records argv, the LD_PRELOAD it saw and a copy of the rendered config with its mode.
 * @returns {{ home: string, record: string }}
 */
function fakeProxychains() {
  const home = mkdtempSync(path.join(scratch, 'pc-'));
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const record = path.join(home, 'record.json');
  const launcher = path.join(bin, 'proxychains4');
  writeFileSync(
    launcher,
    `#!/bin/sh
conf=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -f) conf="$2"; shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
mode=$(stat -c %a "$conf")
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1], JSON.stringify({
  conf: fs.readFileSync(process.argv[2], "utf8"), confPath: process.argv[2], mode: process.argv[3],
  argv: process.argv.slice(4), preload: process.env.LD_PRELOAD ?? null}))' "${record}" "$conf" "$mode" "$@"
exit "\${FAKE_EXIT:-0}"
`,
  );
  chmodSync(launcher, 0o755);
  return { home, record };
}

/**
 * Runs the wrapper with a clean environment. A key set to undefined is unset, so a host ALL_PROXY never leaks in.
 * @param {string} wrapper
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 */
function runWrapper(wrapper, args, env) {
  /** @type {Record<string, string | undefined>} */
  const all = { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: scratch, ...env };
  const merged = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined));
  return spawnSync('sh', [wrapper, ...args], { encoding: 'utf8', env: merged });
}

/**
 * @param {string} file
 * @returns {LauncherRecord}
 */
/**
 * @param {string} text
 * @returns {unknown}
 */
const parseJson = (text) => /** @type {unknown} */ (JSON.parse(text));

/**
 * @param {string} file
 * @returns {LauncherRecord}
 */
const readRecord = (file) => {
  const text = readFileSync(file, 'utf8');
  return /** @type {LauncherRecord} */ (parseJson(text));
};

describe('bw-proxy: argument and gateway validation fails closed', () => {
  const { home } = fakeProxychains();
  const wrapper = wrapperFor(home);

  it('prints usage and exits 64 with no arguments', () => {
    const r = runWrapper(wrapper, [], { ALL_PROXY: 'socks5://egress:1080' });
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage: bw-proxy/);
  });

  it('refuses to run when ALL_PROXY is missing', () => {
    const r = runWrapper(wrapper, ['tool'], { ALL_PROXY: undefined, all_proxy: undefined });
    assert.equal(r.status, 69);
    assert.match(r.stderr, /ALL_PROXY is not set/);
  });

  for (const bad of [
    'http://egress:1080',
    'egress:1080',
    'socks4://egress:1080',
    'socks5://user:pw@egress:1080',
    'socks5://[::1]:1080',
    'socks5://egress',
    'socks5://egress:0',
    'socks5://egress:65536',
    'socks5://egress:10x80',
    'socks5://egress:1080 socks5 attacker.example:1',
    'socks5://egress:1080\nsocks5 attacker.example 1',
    'socks5://egress:1080/../x',
  ]) {
    it(`refuses ALL_PROXY=${JSON.stringify(bad)}`, () => {
      const r = runWrapper(wrapper, ['tool'], { ALL_PROXY: bad });
      assert.equal(r.status, 69, r.stderr);
      assert.match(r.stderr, /ALL_PROXY/);
    });
  }
});

describe('bw-proxy: wraps the tool with a rendered, private config', () => {
  it('runs proxychains with a config that routes through the gateway and resolves DNS remotely', () => {
    const fake = fakeProxychains();
    const wrapper = wrapperFor(fake.home);
    const r = runWrapper(wrapper, ['naabu', '-host', 'app.example.test'], {
      ALL_PROXY: 'socks5://egress:1080',
    });
    assert.equal(r.status, 0, r.stderr);
    const seen = readRecord(fake.record);
    assert.deepEqual(seen.argv, ['naabu', '-host', 'app.example.test']);
    assert.match(seen.conf, /^strict_chain$/m);
    assert.match(seen.conf, /^proxy_dns$/m);
    assert.match(seen.conf, /^socks5 egress 1080$/m);
    assert.doesNotMatch(seen.conf, /@GATEWAY_/);
    assert.doesNotMatch(seen.conf, /^localnet/m);
    assert.equal(seen.mode, '600');
  });

  it('reads the lower-case all_proxy when ALL_PROXY is unset', () => {
    const fake = fakeProxychains();
    const wrapper = wrapperFor(fake.home);
    const r = runWrapper(wrapper, ['tool'], {
      ALL_PROXY: undefined,
      all_proxy: 'socks5h://10.0.0.5:9050',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readRecord(fake.record).conf, /^socks5 10\.0\.0\.5 9050$/m);
  });

  it('removes the rendered config after the tool exits and propagates its exit status', () => {
    const fake = fakeProxychains();
    const wrapper = wrapperFor(fake.home);
    const r = runWrapper(wrapper, ['tool'], { ALL_PROXY: 'socks5://egress:1080', FAKE_EXIT: '7' });
    assert.equal(r.status, 7);
    const { confPath } = readRecord(fake.record);
    assert.equal(existsSync(confPath), false, 'rendered config must not outlive the call');
  });

  it('does not wrap twice when already running under proxychains', () => {
    const fake = fakeProxychains();
    const wrapper = wrapperFor(fake.home);
    const r = runWrapper(wrapper, ['sh', '-c', 'echo nested'], {
      ALL_PROXY: 'socks5://egress:1080',
      LD_PRELOAD: '/opt/bw/tools/lib/proxychains-ng/lib/libproxychains4.so',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'nested');
    assert.equal(existsSync(fake.record), false, 'the launcher must not run again');
  });
});

describe('bw-proxy: build pin and install', () => {
  it('pins proxychains-ng with a version, licence and a 64-hex sha256 in tools.pin.json', () => {
    const pinFile =
      /** @type {{ proxychains: { name: string, version: string, licence: string, sha256: string, url: string } }} */ (
        parseJson(readFileSync(PIN, 'utf8'))
      );
    const pin = pinFile.proxychains;
    assert.equal(pin.name, 'proxychains-ng');
    assert.match(pin.version, /^\d+\.\d+$/);
    assert.equal(pin.licence, 'GPL-2.0-only');
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.ok(pin.url.startsWith('https://'));
    assert.ok(existsSync(BUILD));
    assert.ok((statSync(BUILD).mode & 0o111) !== 0);
  });
});

const integrationHome = process.env.BW_PROXYCHAINS_HOME ?? '/opt/bw/tools/lib/proxychains-ng';
const hasProxychains = existsSync(path.join(integrationHome, 'bin/proxychains4'));

/**
 * @param {import('node:net').Server} server
 * @returns {number}
 */
function portOf(server) {
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('server is not listening on TCP');
  return address.port;
}

/**
 * Minimal SOCKS5 gateway: no auth, CONNECT only. Records every request so tests can see where traffic went.
 * @returns {Promise<Gateway>}
 */
function stubGateway() {
  /** @type {SocksRequest[]} */
  const requests = [];
  const server = createServer((sock) => {
    sock.once('data', (greet) => {
      if (greet.readUInt8(0) !== 5) {
        sock.destroy();
        return;
      }
      sock.write(Buffer.from([5, 0]));
      sock.once('data', (req) => {
        const atyp = req.readUInt8(3);
        let host;
        let off = 0;
        if (atyp === 1) {
          host = [...req.subarray(4, 8)].join('.');
          off = 8;
        } else if (atyp === 3) {
          const len = req.readUInt8(4);
          host = req.subarray(5, 5 + len).toString('utf8');
          off = 5 + len;
        } else {
          sock.destroy();
          return;
        }
        const port = req.readUInt16BE(off);
        requests.push({ atyp, host, port });
        sock.end(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
    sock.on('error', () => {
      // Clients may abort mid-handshake; that is not a failure of the stub.
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: portOf(server),
        requests,
        close: () =>
          new Promise((r) => {
            server.close(() => {
              r();
            });
          }),
      });
    });
  });
}

/**
 * A loopback TCP listener that counts direct, un-proxied connections.
 * @returns {Promise<Target>}
 */
function countingTarget() {
  let hits = 0;
  const server = createServer((s) => {
    hits += 1;
    s.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: portOf(server),
        hits: () => hits,
        close: () =>
          new Promise((r) => {
            server.close(() => {
              r();
            });
          }),
      });
    });
  });
}

// Node connects through libc, so proxychains wraps it. The probe exits 0 on connect, non-zero on refusal.
/**
 * @param {string} host
 * @param {number} port
 * @returns {string} Node source that connects to host:port and exits 0 on success.
 */
const probe = (host, port) =>
  `const s=require("net").connect(${port},${JSON.stringify(host)});` +
  `s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(3));`;

describe(
  'bw-proxy integration: real proxychains-ng',
  { skip: !hasProxychains && `no proxychains-ng at ${integrationHome}` },
  () => {
    /** @type {Gateway} */
    let gateway;
    /** @type {Target} */
    let target;
    before(async () => {
      gateway = await stubGateway();
      target = await countingTarget();
    });
    after(async () => {
      await gateway.close();
      await target.close();
    });

    it('sends the connection and the name lookup through the gateway', () => {
      const wrapper = wrapperFor(integrationHome);
      const r = runWrapper(wrapper, [process.execPath, '-e', probe('target.bw.test', 443)], {
        ALL_PROXY: `socks5://127.0.0.1:${gateway.port}`,
      });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const hit = gateway.requests.find((q) => q.host === 'target.bw.test' && q.port === 443);
      assert.ok(hit, `gateway saw ${JSON.stringify(gateway.requests)}`);
      assert.equal(hit.atyp, 3, 'name sent as a domain, so it was resolved by the gateway');
    });

    it('fails closed when the gateway is down and never connects directly', () => {
      const closed = gateway.port + 1000;
      const wrapper = wrapperFor(integrationHome);
      const hitsBefore = target.hits();
      const r = runWrapper(wrapper, [process.execPath, '-e', probe('127.0.0.1', target.port)], {
        ALL_PROXY: `socks5://127.0.0.1:${closed}`,
      });
      assert.notEqual(r.status, 0, 'a tool must not succeed without the gateway');
      assert.equal(target.hits(), hitsBefore, 'no direct connection reached the target');
    });
  },
);
