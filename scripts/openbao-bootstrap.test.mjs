// OpenBao dev server + bootstrap tests (DEVENV-005, #159).
//
// Runs the compose service's own entrypoint (infra/compose/openbao/start.sh) in throwaway containers on
// random loopback ports (never the shared bwdev stack), then drives infra/compose/openbao/bootstrap.sh
// against them. Every container and volume it creates is removed afterwards.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { COMPOSE_FILE } from './dev-deps.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BAO_DIR = path.join(ROOT, 'infra/compose/openbao');
const BOOTSTRAP = path.join(BAO_DIR, 'bootstrap.sh');
const IMAGE =
  /image: (openbao\/openbao:[^\s]+)/.exec(readFileSync(COMPOSE_FILE, 'utf8'))?.[1] ?? '';

/** @param {string[]} args */
function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Starts the openbao service entrypoint in a throwaway container.
 * @param {{ storage: 'dev' | 'file', rootToken: string, volume?: string }} o
 */
function startServer(o) {
  const name = `bw159-test-${randomBytes(4).toString('hex')}`;
  const args = ['run', '-d', '--name', name, '-p', '127.0.0.1::8200'];
  args.push('-e', `BW_OPENBAO_STORAGE=${o.storage}`, '-e', `BAO_DEV_ROOT_TOKEN_ID=${o.rootToken}`);
  args.push('-e', 'BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200', '-e', 'SKIP_SETCAP=true');
  args.push('-v', `${BAO_DIR}:/bw/openbao:ro`);
  if (o.volume) args.push('-v', `${o.volume}:/openbao/file`);
  args.push('--entrypoint', 'dumb-init', IMAGE, '--', '/bw/openbao/start.sh');
  docker(args);
  const port = docker(['port', name, '8200']).split('\n')[0]?.split(':').at(-1) ?? '';
  return { name, addr: `http://127.0.0.1:${port}` };
}

/**
 * @param {string} addr
 * @param {string} stateDir
 * @param {Record<string, string>} [extra]
 */
function bootstrap(addr, stateDir, extra = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('BW_DEV_')),
  );
  return spawnSync('bash', [BOOTSTRAP], {
    encoding: 'utf8',
    env: {
      ...clean,
      BW_DEV_ENV_FILE: '/dev/null',
      BW_DEV_OPENBAO_ADDR: addr,
      BW_DEV_OPENBAO_STATE_DIR: stateDir,
      BW_DEV_OPENBAO_WAIT_SECONDS: '60',
      ...extra,
    },
  });
}

/**
 * The subset of OpenBao response bodies these tests read (cast from parsed JSON).
 * @typedef {{ type: string, options: { version: string } }} Mount
 * @typedef {{ ciphertext: string, plaintext: string, type: string, exportable: boolean,
 *   deletion_allowed: boolean, latest_version: number, current_version: number,
 *   policies: string[], data: Record<string, string> }} BaoData
 * @typedef {{ data: BaoData }} BaoBody
 */

/**
 * @param {string} addr
 * @param {string} token
 * @param {string} method
 * @param {string} p
 * @param {unknown} [body]
 * @returns {Promise<{ status: number, json: BaoBody }>}
 */
async function api(addr, token, method, p, body) {
  /** @type {RequestInit} */
  const init = { method, headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${addr}/v1/${p}`, init);
  const text = await res.text();
  /** @type {unknown} */
  const parsed = text ? JSON.parse(text) : { data: {} };
  return { status: res.status, json: /** @type {BaoBody} */ (parsed) };
}

/** @param {BaoBody} b @returns {Record<string, Mount | undefined>} */
const mountsOf = (b) =>
  /** @type {Record<string, Mount | undefined>} */ (/** @type {unknown} */ (b.data));

const b64 = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (/** @type {string} */ s) => Buffer.from(s, 'base64').toString('utf8');

describe('openbao scripts (static)', () => {
  it('shellcheck passes for bootstrap, entrypoint and healthcheck', () => {
    const res = spawnSync(
      'shellcheck',
      ['-x', BOOTSTRAP, path.join(BAO_DIR, 'start.sh'), path.join(BAO_DIR, 'healthcheck.sh')],
      { encoding: 'utf8' },
    );
    assert.equal(res.error, undefined, 'shellcheck must be installed');
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });

  it('healthcheck probes /v1/sys/health and the image is pinned by digest', () => {
    assert.match(readFileSync(path.join(BAO_DIR, 'healthcheck.sh'), 'utf8'), /\/v1\/sys\/health/);
    assert.match(IMAGE, /^openbao\/openbao:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it('edge case: token leakage -> the state dir (app token, init keys) is git-ignored', () => {
    for (const f of ['.bw-dev/openbao/app-token', '.bw-dev/openbao/init.json', '.env']) {
      const res = spawnSync('git', ['check-ignore', '-q', f], { cwd: ROOT });
      assert.equal(res.status, 0, `${f} must be git-ignored`);
    }
  });

  it('edge case: bootstrap before OpenBao is ready -> waits, then fails clearly', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-bao-'));
    try {
      const res = bootstrap('http://127.0.0.1:9', dir, {
        BW_DEV_OPENBAO_WAIT_SECONDS: '2',
        BW_DEV_OPENBAO_ROOT_TOKEN: 'x',
      });
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /is not answering \/v1\/sys\/health/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid tenant slug (policy path injection)', () => {
    const res = bootstrap('http://127.0.0.1:9', '/nonexistent', {
      BW_DEV_OPENBAO_TENANTS: 'acme *',
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /invalid tenant slug/);
  });

  it('the dev server refuses to start without a root token (no random/default token)', () => {
    const res = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-e',
        'BW_OPENBAO_STORAGE=dev',
        '-e',
        'BAO_DEV_ROOT_TOKEN_ID=',
        '-v',
        `${BAO_DIR}:/bw/openbao:ro`,
        '--entrypoint',
        'dumb-init',
        IMAGE,
        '--',
        '/bw/openbao/start.sh',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /BAO_DEV_ROOT_TOKEN_ID is empty; refusing to start/);
  });
});

describe('openbao dev server + bootstrap (integration)', () => {
  const rootToken = randomBytes(16).toString('hex');
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'bw-bao-'));
  const tokenFile = path.join(stateDir, 'app-token');
  /** @type {{ name: string, addr: string }} */
  let srv = { name: '', addr: '' };
  /** @type {ReturnType<typeof bootstrap>} */
  let first;
  const appToken = () => readFileSync(tokenFile, 'utf8').trim();
  /** @param {string} m @param {string} p @param {unknown} [b] */
  const root = (m, p, b) => api(srv.addr, rootToken, m, p, b);
  /** @param {string} m @param {string} p @param {unknown} [b] */
  const app = (m, p, b) => api(srv.addr, appToken(), m, p, b);

  before(() => {
    srv = startServer({ storage: 'dev', rootToken });
    // Run immediately: the bootstrap itself must wait for the server.
    first = bootstrap(srv.addr, stateDir, { BW_DEV_OPENBAO_ROOT_TOKEN: rootToken });
  });

  after(() => {
    if (srv.name) spawnSync('docker', ['rm', '-f', srv.name]);
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('bootstrap enables Transit and KV v2 and the declarative audit device', async () => {
    assert.equal(first.status, 0, first.stderr);
    const mounts = mountsOf((await root('GET', 'sys/mounts')).json);
    assert.equal(mounts['transit/']?.type, 'transit');
    const kv = mounts['secret/'];
    assert.ok(kv, 'secret/ is mounted');
    assert.equal(kv.type, 'kv');
    assert.equal(kv.options.version, '2');
    const audit = await root('GET', 'sys/audit');
    assert.ok(Object.keys(audit.json.data).length >= 1, 'audit device enabled');
    const health = await fetch(`${srv.addr}/v1/sys/health`);
    assert.equal(health.status, 200);
    // The compose healthcheck script itself reports healthy inside the container.
    const hc = spawnSync('docker', ['exec', srv.name, '/bw/openbao/healthcheck.sh']);
    assert.equal(hc.status, 0, 'compose healthcheck passes');
    const logs = spawnSync('docker', ['logs', srv.name], { encoding: 'utf8' });
    assert.match(logs.stdout + logs.stderr, /"type":"request"/, 'audit entries on stdout');
    assert.ok(!(logs.stdout + logs.stderr).includes(appToken()), 'audit log HMACs tokens');
  });

  it('never prints the root or app token', () => {
    const out = first.stdout + first.stderr;
    assert.ok(!out.includes(rootToken));
    assert.ok(!out.includes(appToken()));
  });

  it('creates transit/keys/tenant-acme (not exportable, deletable for shred)', async () => {
    const key = await root('GET', 'transit/keys/tenant-acme');
    assert.equal(key.status, 200);
    assert.equal(key.json.data.type, 'aes256-gcm96');
    assert.equal(key.json.data.exportable, false);
    assert.equal(key.json.data.deletion_allowed, true);
    assert.equal(key.json.data.latest_version, 1);
  });

  it('app token round-trips encrypt/decrypt and the envelope (data key) flow', async () => {
    const enc = await app('POST', 'transit/encrypt/tenant-acme', { plaintext: b64('hello acme') });
    assert.equal(enc.status, 200);
    assert.match(enc.json.data.ciphertext, /^vault:v1:/);
    const dec = await app('POST', 'transit/decrypt/tenant-acme', {
      ciphertext: enc.json.data.ciphertext,
    });
    assert.equal(unb64(dec.json.data.plaintext), 'hello acme');

    const dk = await app('POST', 'transit/datakey/plaintext/tenant-acme', { bits: 256 });
    assert.equal(dk.status, 200);
    const unwrapped = await app('POST', 'transit/decrypt/tenant-acme', {
      ciphertext: dk.json.data.ciphertext,
    });
    assert.equal(unwrapped.json.data.plaintext, dk.json.data.plaintext);
    assert.equal(Buffer.from(dk.json.data.plaintext, 'base64').length, 32);
  });

  it('app token reads its platform KV paths', async () => {
    const smtp = await app('GET', 'secret/data/platform/smtp');
    assert.equal(smtp.status, 200);
    assert.equal(smtp.json.data.data.host, 'mailpit');
    const ish = await app('GET', 'secret/data/platform/interactsh');
    assert.equal(ish.status, 200);
  });

  it('edge case: wrong policy (too broad) -> app token cannot reach root or other paths', async () => {
    await root('POST', 'secret/data/admin/root-only', { data: { v: 'x' } });
    /** @type {[string, string, unknown?][]} */
    const denied = [
      ['GET', 'secret/data/admin/root-only'],
      ['POST', 'secret/data/platform/smtp', { data: { host: 'evil' } }],
      ['DELETE', 'secret/metadata/platform/smtp'],
      ['GET', 'sys/mounts'],
      ['GET', 'sys/policies/acl/bw-app-platform'],
      ['GET', 'sys/audit'],
      ['POST', 'sys/mounts/evil', { type: 'kv' }],
      ['POST', 'auth/token/create', { policies: ['root'] }],
      ['POST', 'auth/token/create/bw-app', {}],
      ['GET', 'transit/keys/tenant-acme'],
      ['POST', 'transit/keys/tenant-acme/rotate'],
      ['POST', 'transit/keys/tenant-acme/config', { exportable: true }],
      ['GET', 'transit/export/encryption-key/tenant-acme'],
      ['GET', 'transit/backup/tenant-acme'],
      ['DELETE', 'transit/keys/tenant-acme'],
    ];
    for (const [m, p, b] of denied) {
      const res = await app(m, p, b);
      assert.equal(res.status, 403, `${m} ${p} must be denied, got ${String(res.status)}`);
    }
    const self = await app('GET', 'auth/token/lookup-self');
    assert.deepEqual([...self.json.data.policies].sort(), [
      'bw-app-platform',
      'bw-app-tenant-acme',
      'default',
    ]);
  });

  it("edge case: app token cannot use another tenant's key", async () => {
    assert.ok([200, 204].includes((await root('POST', 'transit/keys/tenant-globex', {})).status));
    const enc = await root('POST', 'transit/encrypt/tenant-globex', { plaintext: b64('globex') });
    for (const p of ['encrypt', 'datakey/plaintext', 'datakey/wrapped']) {
      const res = await app('POST', `transit/${p}/tenant-globex`, { plaintext: b64('x') });
      assert.equal(res.status, 403, p);
    }
    const dec = await app('POST', 'transit/decrypt/tenant-globex', {
      ciphertext: enc.json.data.ciphertext,
    });
    assert.equal(dec.status, 403);
    // A tenant-acme key cannot decrypt globex ciphertext either.
    const cross = await app('POST', 'transit/decrypt/tenant-acme', {
      ciphertext: enc.json.data.ciphertext,
    });
    assert.equal(cross.status, 400);
  });

  it('re-running the bootstrap creates no duplicate mounts, keys, secret versions or tokens', async () => {
    const mountsBefore = Object.keys((await root('GET', 'sys/mounts')).json.data).sort();
    const tokenBefore = appToken();
    const second = bootstrap(srv.addr, stateDir, { BW_DEV_OPENBAO_ROOT_TOKEN: rootToken });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /transit\/ already enabled/);
    assert.match(second.stderr, /tenant-acme already exists/);
    assert.match(second.stderr, /app token .* is valid; kept/);
    assert.deepEqual(Object.keys((await root('GET', 'sys/mounts')).json.data).sort(), mountsBefore);
    assert.equal((await root('GET', 'transit/keys/tenant-acme')).json.data.latest_version, 1);
    const meta = await root('GET', 'secret/metadata/platform/smtp');
    assert.equal(meta.json.data.current_version, 1);
    assert.equal(appToken(), tokenBefore);
  });

  it('writes the app token file 0600 inside a 0700 state dir', () => {
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  });

  it('edge case: key rotation -> old ciphertext still decrypts and can be rewrapped', async () => {
    const old = await app('POST', 'transit/encrypt/tenant-acme', { plaintext: b64('v1 data') });
    assert.equal((await root('POST', 'transit/keys/tenant-acme/rotate')).status, 200);
    const fresh = await app('POST', 'transit/encrypt/tenant-acme', { plaintext: b64('v2 data') });
    assert.match(fresh.json.data.ciphertext, /^vault:v2:/);
    const dec = await app('POST', 'transit/decrypt/tenant-acme', {
      ciphertext: old.json.data.ciphertext,
    });
    assert.equal(unb64(dec.json.data.plaintext), 'v1 data');
    const rewrapped = await app('POST', 'transit/rewrap/tenant-acme', {
      ciphertext: old.json.data.ciphertext,
    });
    assert.match(rewrapped.json.data.ciphertext, /^vault:v2:/);
    // Re-running the bootstrap after a rotation keeps both versions.
    const again = bootstrap(srv.addr, stateDir, { BW_DEV_OPENBAO_ROOT_TOKEN: rootToken });
    assert.equal(again.status, 0, again.stderr);
    assert.equal((await root('GET', 'transit/keys/tenant-acme')).json.data.latest_version, 2);
  });

  it('re-issues the app token when the stored one is no longer valid', async () => {
    const stale = appToken();
    await root('POST', 'auth/token/revoke', { token: stale });
    const res = bootstrap(srv.addr, stateDir, { BW_DEV_OPENBAO_ROOT_TOKEN: rootToken });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /issued a new app token/);
    assert.notEqual(appToken(), stale);
    assert.equal((await app('GET', 'secret/data/platform/smtp')).status, 200);
  });

  it('fails closed with a wrong root token', () => {
    const res = bootstrap(srv.addr, stateDir, { BW_DEV_OPENBAO_ROOT_TOKEN: 'wrong-token' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /root token check failed \(HTTP 403\)/);
  });
});

describe('openbao file backend (edge case: dev server data not persisted)', () => {
  const volume = `bw159-test-${randomBytes(4).toString('hex')}`;
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'bw-bao-'));
  /** @type {{ name: string, addr: string }} */
  let srv = { name: '', addr: '' };

  before(() => {
    docker(['volume', 'create', volume]);
    srv = startServer({ storage: 'file', rootToken: 'unused-in-file-mode', volume });
  });

  after(() => {
    if (srv.name) spawnSync('docker', ['rm', '-f', srv.name]);
    spawnSync('docker', ['volume', 'rm', '-f', volume]);
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('initialises, unseals and keeps keys across a restart', async () => {
    const env = { BW_DEV_OPENBAO_STORAGE: 'file' };
    const one = bootstrap(srv.addr, stateDir, env);
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stderr, /initialising the persistent dev server/);
    assert.equal(statSync(path.join(stateDir, 'init.json')).mode & 0o777, 0o600);
    const token = () => readFileSync(path.join(stateDir, 'app-token'), 'utf8').trim();
    const enc = await api(srv.addr, token(), 'POST', 'transit/encrypt/tenant-acme', {
      plaintext: b64('persisted'),
    });
    assert.equal(enc.status, 200);

    docker(['restart', srv.name]);
    srv = {
      name: srv.name,
      addr: `http://127.0.0.1:${docker(['port', srv.name, '8200']).split(':').at(-1) ?? ''}`,
    };
    const two = bootstrap(srv.addr, stateDir, env);
    assert.equal(two.status, 0, two.stderr);
    assert.match(two.stderr, /unsealing/);
    assert.match(two.stderr, /tenant-acme already exists/);
    assert.match(two.stderr, /app token .* is valid; kept/);
    const dec = await api(srv.addr, token(), 'POST', 'transit/decrypt/tenant-acme', {
      ciphertext: enc.json.data.ciphertext,
    });
    assert.equal(dec.status, 200);
    assert.equal(unb64(dec.json.data.plaintext), 'persisted');
  });
});
