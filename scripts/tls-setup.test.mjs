import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { COMPOSE_FILE, PROJECT, SETUP_TLS } from './dev-deps.mjs';

const TLS_DIR = path.dirname(SETUP_TLS);
const REPO = path.resolve(TLS_DIR, '../../..');
const HOSTS = /** @type {const} */ (['app', 'api', 'auth', 'juice']);
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

/**
 * @param {Record<string, string>} [env]
 * @param {string[]} [args]
 */
function composeConfig(env = {}, args = /** @type {string[]} */ ([])) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('BW_')),
  );
  const res = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      PROJECT,
      '--env-file',
      '/dev/null',
      '-f',
      COMPOSE_FILE,
      ...args,
      'config',
      '--format',
      'json',
    ],
    {
      encoding: 'utf8',
      env: {
        ...clean,
        BW_DEV_POSTGRES_SUPERUSER_PASSWORD: 'x',
        BW_DEV_POSTGRES_APP_PASSWORD: 'x',
        BW_DEV_POSTGRES_MIGRATOR_PASSWORD: 'x',
        BW_DEV_VALKEY_PASSWORD: 'x',
        BW_DEV_NEO4J_PASSWORD: 'x-neo4j-pass',
        BW_DEV_INTERACTSH_TOKEN: 'x-interactsh-token',
        BW_DEV_KEYCLOAK_ADMIN_PASSWORD: 'x-kc-admin',
        BW_DEV_KEYCLOAK_DB_PASSWORD: 'x-kc-db',
        BW_DEV_KEYCLOAK_TEST_USER_PASSWORD: 'x-kc-users',
        BW_DEV_KEYCLOAK_BFF_SECRET: 'x-kc-bff',
        BW_DEV_KEYCLOAK_API_SECRET: 'x-kc-api',
        BW_DEV_KEYCLOAK_CI_SECRET: 'x-kc-ci',
        BW_DEV_MINIO_ROOT_PASSWORD: 'x-minio-root',
        BW_DEV_MINIO_APP_PASSWORD: 'x-minio-app-secret',
        BW_DEV_GRAFANA_ADMIN_PASSWORD: 'x-grafana-admin',
        ...env,
      },
    },
  );
  assert.equal(res.status, 0, res.stderr);
  /** @type {unknown} */
  const parsed = JSON.parse(res.stdout);
  return /** @type {{ services: Record<string, { image: string, ports?: { host_ip?: string, published?: string, target: number }[] }> }} */ (
    parsed
  ).services;
}

/**
 * Fake mkcert: writes a real self-signed cert (openssl) so expiry checks are genuine.
 * @param {string} binDir
 * @param {string} caroot
 * @param {string} logFile
 */
function installFakeMkcert(binDir, caroot, logFile) {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(caroot, { recursive: true });
  writeFileSync(path.join(caroot, 'rootCA.pem'), 'PUBLIC-CA\n');
  writeFileSync(path.join(caroot, 'rootCA-key.pem'), 'SECRET-CA-KEY\n');
  const script = `#!/usr/bin/env bash
echo "$*" >> "${logFile}"
case "$1" in
  -CAROOT) echo "${caroot}"; exit 0 ;;
  -install) [ -n "\${FAKE_INSTALL_FAIL:-}" ] && exit 1; exit 0 ;;
esac
cert=""; key=""
while [ $# -gt 0 ]; do
  case "$1" in
    -cert-file) cert="$2"; shift 2 ;;
    -key-file) key="$2"; shift 2 ;;
    *) shift ;;
  esac
done
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$key" -out "$cert" -days "\${FAKE_DAYS:-365}" -subj "/CN=fake" >/dev/null 2>&1
`;
  const f = path.join(binDir, 'mkcert');
  writeFileSync(f, script);
  chmodSync(f, 0o755);
}

describe('DEVENV-013 setup-tls.sh', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'bw-tls-'));
  const bin = path.join(work, 'bin');
  const caroot = path.join(work, 'caroot');
  const out = path.join(work, 'certs');
  const log = path.join(work, 'mkcert.log');
  installFakeMkcert(bin, caroot, log);
  after(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /** @param {string[]} args @param {Record<string, string>} [env] @param {string} [pathVar] */
  const run = (args, env = {}, pathVar = `${bin}:${process.env.PATH ?? ''}`) =>
    spawnSync('bash', [SETUP_TLS, ...args], {
      encoding: 'utf8',
      env: { PATH: pathVar, HOME: work, BW_TLS_DIR: out, ...env },
    });
  const certCalls = () =>
    existsSync(log)
      ? read(log)
          .split('\n')
          .filter((l) => l.includes('-cert-file'))
      : [];

  it('is syntactically valid bash and shellcheck-clean when shellcheck is present', () => {
    assert.equal(spawnSync('bash', ['-n', SETUP_TLS]).status, 0);
    const sc = spawnSync('shellcheck', [SETUP_TLS], { encoding: 'utf8' });
    if (!sc.error) assert.equal(sc.status, 0, sc.stdout);
  });

  it('installs the CA, issues the *.bw.localhost wildcard, and exports only the public CA', () => {
    const res = run([]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(read(log), /^-install$/m);
    const [call] = certCalls();
    assert.ok(call !== undefined, 'mkcert cert call');
    assert.ok(call.includes('*.bw.localhost'));
    assert.ok(call.includes('127.0.0.1'));
    assert.ok(existsSync(path.join(out, 'bw-localhost.pem')));
    assert.equal(statSync(path.join(out, 'bw-localhost-key.pem')).mode & 0o777, 0o600);
    assert.equal(read(path.join(out, 'rootCA.pem')), 'PUBLIC-CA\n');
    assert.equal(existsSync(path.join(out, 'rootCA-key.pem')), false, 'CA key must not be copied');
    assert.doesNotMatch(res.stdout + res.stderr, /SECRET-CA-KEY/);
  });

  it('is idempotent while the certificate is valid, and --force regenerates it', () => {
    assert.equal(run([]).status, 0);
    assert.equal(certCalls().length, 1);
    assert.equal(run(['--force']).status, 0);
    assert.equal(certCalls().length, 2);
  });

  it('regenerates an expiring certificate (cert expiry edge case)', () => {
    const before = certCalls().length;
    assert.equal(run(['--force'], { FAKE_DAYS: '5' }).status, 0);
    assert.equal(certCalls().length, before + 1);
    const res = run([]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(certCalls().length, before + 2, 'cert valid <30 days must be renewed');
  });

  it('continues with guidance when mkcert -install fails (headless CI)', () => {
    const res = run(['--force'], { FAKE_INSTALL_FAIL: '1' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /NODE_EXTRA_CA_CERTS=/);
  });

  it('fails with an actionable message when mkcert is missing', () => {
    const res = run([], {}, '/usr/bin:/bin');
    // a host mkcert in /usr/bin would defeat this; only assert when it is genuinely absent
    if (!existsSync('/usr/bin/mkcert') && !existsSync('/bin/mkcert')) {
      assert.equal(res.status, 1);
      assert.match(res.stderr, /mkcert not found/);
    }
  });

  it('prints /etc/hosts guidance for every routed hostname and rejects unknown flags', () => {
    const hosts = run(['--print-hosts']);
    assert.equal(hosts.status, 0);
    for (const h of HOSTS) assert.match(hosts.stdout, new RegExp(`\\b${h}\\.bw\\.localhost\\b`));
    assert.equal(run(['--bogus']).status, 2);
  });
});

describe('DEVENV-013 cert material is git-ignored', () => {
  for (const f of [
    'infra/compose/tls/certs/bw-localhost.pem',
    'infra/compose/tls/certs/bw-localhost-key.pem',
    'infra/compose/tls/certs/rootCA.pem',
    'infra/compose/tls/certs/rootCA-key.pem',
  ]) {
    it(`ignores ${f}`, () => {
      const res = spawnSync('git', ['check-ignore', '-q', f], { cwd: REPO });
      assert.equal(res.status, 0, `${f} must be ignored`);
    });
  }
  it('tracks no cert or key files under infra/compose/tls', () => {
    const files = execFileSync('git', ['ls-files', 'infra/compose/tls'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    assert.doesNotMatch(files, /\.(pem|key|crt|p12)$/m);
  });
});

describe('DEVENV-013 compose + routing config', () => {
  it('keeps Traefik opt-in (profile tls), pinned by digest, loopback-only on high ports', () => {
    assert.equal(composeConfig().traefik, undefined);
    const t = composeConfig({}, ['--profile', 'tls']).traefik;
    assert.ok(t, 'traefik service present with profile tls');
    assert.match(t.image, /^traefik:v3\.[^@]+@sha256:[0-9a-f]{64}$/);
    const ports = Object.fromEntries((t.ports ?? []).map((p) => [p.target, p]));
    assert.equal(ports[443]?.published, '18443');
    assert.equal(ports[80]?.published, '18000');
    assert.equal(ports[8080]?.published, '18082');
    assert.ok((t.ports ?? []).every((p) => p.host_ip === '127.0.0.1'));
  });

  it('lets the HTTPS port be overridden (port 443 privileges edge case)', () => {
    const t = composeConfig({ BW_DEV_TRAEFIK_HTTPS_PORT: '443' }, ['--profile', 'tls']).traefik;
    assert.equal(t?.ports?.find((p) => p.target === 443)?.published, '443');
  });

  it('routes each hostname to its own service over TLS only', () => {
    const dyn = read(path.join(TLS_DIR, 'traefik/dynamic.yml'));
    const routes = {
      app: 'web',
      api: 'api',
      auth: 'keycloak',
    };
    for (const [host, svc] of Object.entries(routes)) {
      const m = new RegExp(
        `Host\\(\`${host}\\.bw\\.localhost\`\\)\\n\\s+entryPoints: \\[websecure\\]\\n\\s+service: ${svc}\\n\\s+tls: \\{\\}`,
      );
      assert.match(dyn, m, `${host} -> ${svc}`);
    }
    assert.doesNotMatch(dyn, /Strict-Transport-Security|stsSeconds/);
  });

  it('keeps hostnames in sync with the Keycloak issuer/redirect hostnames when present', () => {
    const env = read(path.join(REPO, '.env.example'));
    const urls = [...env.matchAll(/https:\/\/([a-z]+)\.bw\.localhost/g)].map((m) => m[1]);
    for (const u of urls) assert.ok(HOSTS.includes(/** @type {never} */ (u)), `unrouted host ${u}`);
  });
});

/** Starts a tiny upstream that reports which service answered and the forwarded proto. */
/** @param {string} name @returns {Promise<{ server: http.Server, port: number }>} */
function upstream(name) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name, proto: req.headers['x-forwarded-proto'] }));
    });
    server.listen(0, '0.0.0.0', () => {
      resolve({
        server,
        port: /** @type {import('node:net').AddressInfo} */ (server.address()).port,
      });
    });
  });
}

/**
 * @param {number} port
 * @param {string} host
 * @param {string} ca
 * @returns {Promise<{ status: number, body: string }>}
 */
function get(port, host, ca) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: '/', headers: { host }, servername: host, ca },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe(
  'DEVENV-013 Traefik end to end (real container, openssl test CA)',
  { skip: !hasDocker },
  () => {
    const work = mkdtempSync(path.join(tmpdir(), 'bw-traefik-'));
    /** @type {string} */ let cid = '';
    /** @type {number} */ let httpsPort = 0;
    /** @type {number} */ let httpPort = 0;
    const servers = /** @type {http.Server[]} */ ([]);
    /** @type {string} */ let ca = '';

    before(async () => {
      const certs = path.join(work, 'certs');
      mkdirSync(certs);
      const cnf = path.join(work, 'openssl.cnf');
      writeFileSync(
        cnf,
        '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=bw-test\n[v3]\nsubjectAltName=DNS:*.bw.localhost,DNS:bw.localhost\nbasicConstraints=CA:TRUE\n',
      );
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '2',
          '-config',
          cnf,
          '-keyout',
          path.join(certs, 'bw-localhost-key.pem'),
          '-out',
          path.join(certs, 'bw-localhost.pem'),
        ],
        { stdio: 'ignore' },
      );
      chmodSync(certs, 0o755);
      chmodSync(path.join(certs, 'bw-localhost-key.pem'), 0o644);
      ca = read(path.join(certs, 'bw-localhost.pem'));

      /** @type {Record<string, number>} */
      const ports = {};
      for (const n of ['web', 'api', 'keycloak']) {
        const u = await upstream(n);
        servers.push(u.server);
        ports[n] = u.port;
      }
      const up = (/** @type {string} */ n) => `http://host.docker.internal:${String(ports[n])}`;
      cid = execFileSync(
        'docker',
        [
          'run',
          '-d',
          '--rm',
          '--add-host',
          'host.docker.internal:host-gateway',
          '-p',
          '127.0.0.1::443',
          '-p',
          '127.0.0.1::80',
          '-e',
          'BW_TLS_PUBLIC_HTTPS_PORT=18443',
          '-e',
          `BW_TLS_UPSTREAM_WEB=${up('web')}`,
          '-e',
          `BW_TLS_UPSTREAM_API=${up('api')}`,
          '-e',
          `BW_TLS_UPSTREAM_KEYCLOAK=${up('keycloak')}`,
          '-v',
          `${path.join(TLS_DIR, 'traefik/traefik.yml')}:/etc/traefik/traefik.yml:ro`,
          '-v',
          `${path.join(TLS_DIR, 'traefik/dynamic.yml')}:/etc/traefik/dynamic.yml:ro`,
          '-v',
          `${certs}:/certs:ro`,
          composeConfig({}, ['--profile', 'tls']).traefik?.image ?? 'traefik:v3.2',
          '--configFile=/etc/traefik/traefik.yml',
        ],
        { encoding: 'utf8' },
      ).trim();
      const portOf = (/** @type {string} */ p) =>
        Number(
          execFileSync('docker', ['port', cid, p], { encoding: 'utf8' })
            .split('\n')[0]
            ?.split(':')
            .pop(),
        );
      httpsPort = portOf('443/tcp');
      httpPort = portOf('80/tcp');
      for (let i = 0; i < 40; i++) {
        try {
          await get(httpsPort, 'app.bw.localhost', ca);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    });

    after(() => {
      if (cid) spawnSync('docker', ['rm', '-f', cid], { stdio: 'ignore' });
      for (const s of servers) s.close();
      rmSync(work, { recursive: true, force: true });
    });

    for (const [host, svc] of [
      ['app', 'web'],
      ['api', 'api'],
      ['auth', 'keycloak'],
    ]) {
      it(`serves ${host}.bw.localhost from ${svc} over trusted HTTPS with forwarded proto https`, async () => {
        const r = await get(httpsPort, `${host}.bw.localhost`, ca);
        assert.equal(r.status, 200);
        assert.deepEqual(JSON.parse(r.body), { name: svc, proto: 'https' });
      });
    }

    it('answers 404 for an unrouted hostname and redirects plain HTTP to HTTPS', async () => {
      const r = await get(httpsPort, 'nope.bw.localhost', ca);
      assert.equal(r.status, 404);
      /** @type {{ status: number | undefined, location: string | undefined }} */
      const status = await new Promise((resolve, reject) => {
        http
          .get(
            { host: '127.0.0.1', port: httpPort, headers: { host: 'app.bw.localhost' } },
            (res) => {
              res.resume();
              resolve({ status: res.statusCode, location: res.headers.location });
            },
          )
          .on('error', reject);
      });
      assert.equal(status.status, 302);
      assert.match(status.location ?? '', /^https:\/\/app\.bw\.localhost:18443\//);
    });
  },
);
