// Local integration test for the out-of-band listener (INFRA-010). It renders infra/helm/bw-oob and runs
// the pinned interactsh-server image with the rendered arguments and the same hardening (uid 65532,
// read-only root filesystem, no capabilities), on random loopback ports. It then proves, against the
// running server: a DNS query for a random label under the delegated zone is answered with the public
// address, HTTP and HTTPS requests to that label are served, HTTPS validates the zone certificate, and the
// poll API rejects requests without the token. It needs docker and openssl; it never touches a public
// address, Route53 or Let's Encrypt. The live half (the real delegation, from the dedicated node) is #910,
// see docs/runbooks/oob-server.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAllDocuments } from 'yaml';

/** @typedef {Record<string, unknown>} Obj */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHART = path.join(REPO, 'infra', 'helm', 'bw-oob');
const DOMAIN = 'bw.example';
const PUBLIC_IP = '203.0.113.10';

const TOKEN_BYTES = 12;
const TOKEN = `t-${crypto.randomBytes(TOKEN_BYTES).toString('hex')}`;
const LABEL_BYTES = 6;
const SUFFIX_BYTES = 4;
const DNS_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 30000;
const READY_POLL_MS = 500;
const RCODE_MASK = 0x0f;
const RCODE_OFFSET = 3;
const ANCOUNT_OFFSET = 6;
const DIR_MODE = 0o755;
const FILE_MODE = 0o644;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
/** DNS header (id 0x1234, recursion desired, one question), then the QTYPE A and QCLASS IN fields. */
const DNS_HEADER_HEX = '123401000001000000000000';
const DNS_QTYPE_QCLASS_HEX = '00010001';
const DNS_ANSWER_ADDRESS_BYTES = 4;

/** @param {unknown} v @returns {v is Obj} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Walks a dotted path ("spec.template.spec") through parsed YAML. A numeric segment indexes an array.
 * @param {unknown} o @param {string} p @returns {unknown}
 */
function at(o, p) {
  let cur = o;
  for (const key of p.split('.')) {
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = /** @type {Obj} */ (cur)[key];
  }
  return cur;
}

/** @param {string} cmd @param {string[]} args @returns {{ status: number | null, stdout: string, stderr: string }} */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** @returns {Promise<number>} a free loopback TCP port */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (typeof addr === 'object' && addr !== null) {
        const { port } = addr;
        s.close(() => {
          resolve(port);
        });
      } else {
        s.close(() => {
          reject(new Error('no port'));
        });
      }
    });
  });
}

/**
 * Builds a single DNS A query for `name` (RFC 1035).
 * @param {string} name @returns {Buffer}
 */
function dnsQuery(name) {
  const labels = name
    .split('.')
    .map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  return Buffer.concat([
    Buffer.from(DNS_HEADER_HEX, 'hex'),
    ...labels,
    Buffer.from([0x00]),
    Buffer.from(DNS_QTYPE_QCLASS_HEX, 'hex'),
  ]);
}

/**
 * @param {string} name @param {number} port
 * @returns {Promise<{ rcode: number, ancount: number, address: string | undefined }>}
 */
function resolveA(name, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('DNS query timed out'));
    }, DNS_TIMEOUT_MS);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      const rcode = msg[RCODE_OFFSET] & RCODE_MASK;
      const ancount = msg.readUInt16BE(ANCOUNT_OFFSET);
      // The answer is the last 4 bytes of a single A record with a 4-byte RDATA.
      const address =
        ancount > 0
          ? [...msg.subarray(msg.length - DNS_ANSWER_ADDRESS_BYTES)].join('.')
          : undefined;
      resolve({ rcode, ancount, address });
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      sock.close();
      reject(e);
    });
    sock.send(dnsQuery(name), port, '127.0.0.1');
  });
}

/**
 * @param {{ port: number, host: string, path?: string, headers?: Record<string, string>, tls?: { ca: string, servername: string } }} o
 * @returns {Promise<{ status: number, body: string }>}
 */
function get(o) {
  return new Promise((resolve, reject) => {
    const common = {
      host: '127.0.0.1',
      port: o.port,
      path: o.path ?? '/',
      headers: { host: o.host, ...o.headers },
    };
    /** @param {import('node:http').IncomingMessage} res */
    const onResponse = (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on(
        'data',
        /** @param {string} c */ (c) => {
          body += c;
        },
      );
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    };
    const req = o.tls
      ? https.request(
          { ...common, rejectUnauthorized: true, ca: o.tls.ca, servername: o.tls.servername },
          onResponse,
        )
      : http.request(common, onResponse);
    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

/**
 * Waits until the container's HTTP listener answers, or fails after `ms`.
 * @param {number} port @param {number} [ms]
 */
async function waitForHttp(port, ms = READY_TIMEOUT_MS) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await get({ port, host: 'localhost' });
      if (r.status === HTTP_OK) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > until) throw new Error('interactsh-server did not become ready');
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
}

/** @returns {string} a random label under the delegated zone */
const randomLabel = () => `${crypto.randomBytes(LABEL_BYTES).toString('hex')}.oob.${DOMAIN}`;

const DOCKER = run('docker', ['info', '--format', '{{.ServerVersion}}']);
const SKIP =
  DOCKER.status === 0 ? undefined : 'docker is not reachable: this integration test needs it';

describe('bw-oob local integration (pinned interactsh-server)', { skip: SKIP }, () => {
  /** @type {string} */ let workdir;
  /** @type {string} */ let name;
  /** @type {{ dns: number, http: number, https: number }} */ let ports;
  /** @type {string} */ let ca;
  /** @type {string[]} */ let args;
  /** @type {string} */ let image;

  before(async () => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-oob-int-'));
    name = `bw-oob-int-${crypto.randomBytes(SUFFIX_BYTES).toString('hex')}`;

    // The rendered container spec is what runs: arguments and image come from the chart.
    const rendered = run('helm', [
      'template',
      'bw-oob',
      CHART,
      '-n',
      'bw-oob',
      '--set',
      `domain=${DOMAIN}`,
      '--set',
      `publicIP=${PUBLIC_IP}`,
      '--set',
      'existingSecret=bw-oob-token',
    ]);
    assert.equal(rendered.status, 0, rendered.stderr);
    const deployment = parseAllDocuments(rendered.stdout)
      .map((d) => {
        /** @type {unknown} */
        const js = d.toJS();
        return js;
      })
      .find((d) => isObj(d) && d.kind === 'Deployment');
    const container = /** @type {Obj} */ (at(deployment, 'spec.template.spec.containers.0'));
    image = String(container.image);
    // The chart reads the token from a Secret; locally the same env name carries the test token.
    args = /** @type {string[]} */ (container.args);

    fs.writeFileSync(path.join(workdir, 'config.yaml'), '# intentionally empty\n');
    const key = path.join(workdir, 'tls.key');
    const crt = path.join(workdir, 'tls.crt');
    const ssl = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        key,
        '-out',
        crt,
        '-days',
        '2',
        '-subj',
        `/CN=*.oob.${DOMAIN}`,
        '-addext',
        `subjectAltName=DNS:*.oob.${DOMAIN},DNS:oob.${DOMAIN}`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(ssl.status, 0, ssl.stderr);
    fs.chmodSync(workdir, DIR_MODE);
    for (const f of ['tls.key', 'tls.crt', 'config.yaml'])
      fs.chmodSync(path.join(workdir, f), FILE_MODE);
    ca = fs.readFileSync(crt, 'utf8');

    ports = { dns: await freePort(), http: await freePort(), https: await freePort() };
    const started = run('docker', [
      'run',
      '-d',
      '--name',
      name,
      '--user',
      '65532:65532',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,size=64m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '-e',
      'HOME=/tmp',
      '-e',
      `INTERACTSH_TOKEN=${TOKEN}`,
      '-v',
      `${workdir}/tls.crt:/tls/tls.crt:ro`,
      '-v',
      `${workdir}/tls.key:/tls/tls.key:ro`,
      '-v',
      `${workdir}/config.yaml:/config/interactsh.yaml:ro`,
      '-p',
      `127.0.0.1:${ports.dns}:5353/udp`,
      '-p',
      `127.0.0.1:${ports.http}:8080/tcp`,
      '-p',
      `127.0.0.1:${ports.https}:8443/tcp`,
      '--entrypoint',
      'interactsh-server',
      image,
      ...args.map((a) => (a === '$(INTERACTSH_TOKEN)' ? TOKEN : a)),
    ]);
    assert.equal(started.status, 0, started.stderr);
    await waitForHttp(ports.http);
  });

  after(() => {
    run('docker', ['rm', '-f', name]);
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('answers a DNS query for a random label under the zone with the public address', async () => {
    const r = await resolveA(randomLabel(), ports.dns);
    assert.equal(r.rcode, 0);
    assert.equal(r.ancount, 1);
    assert.equal(r.address, PUBLIC_IP);
  });

  it('serves HTTP for a random label under the zone', async () => {
    const r = await get({ port: ports.http, host: randomLabel(), path: '/probe' });
    assert.equal(r.status, HTTP_OK);
  });

  it('serves HTTPS with a certificate that validates for the zone', async () => {
    const label = randomLabel();
    const r = await get({
      port: ports.https,
      host: label,
      path: '/probe',
      tls: { ca, servername: label },
    });
    assert.equal(r.status, HTTP_OK);
  });

  it('rejects the poll API without the token and with a wrong token', async () => {
    const q = '/poll?id=0000000000000000000000&secret=00000000-0000-0000-0000-000000000000';
    const none = await get({ port: ports.http, host: `oob.${DOMAIN}`, path: q });
    assert.equal(none.status, HTTP_UNAUTHORIZED);
    const wrong = await get({
      port: ports.http,
      host: `oob.${DOMAIN}`,
      path: q,
      headers: { authorization: 'not-the-token' },
    });
    assert.equal(wrong.status, HTTP_UNAUTHORIZED);
  });

  it('runs as the non-root uid with a read-only root filesystem', () => {
    const r = run('docker', [
      'inspect',
      name,
      '--format',
      '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}',
    ]);
    assert.equal(r.stdout.trim(), '65532:65532 true');
  });
});
