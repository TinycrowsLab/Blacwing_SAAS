// Tests for the k3s node bootstrap (INFRA-004): infra/tofu/modules/k3s/files/bw-k3s-bootstrap.sh
// runs against fakes (IMDSv2, SSM, CloudWatch Logs, artifact mirror, systemd, NTP) under a
// temporary root. Nothing here touches the network or the host's systemd.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { REPO_ROOT } from './test-fixtures.mjs';

const MODULE = path.join(REPO_ROOT, 'infra/tofu/modules/k3s');
const SCRIPT = path.join(MODULE, 'files/bw-k3s-bootstrap.sh');
const FAKES = path.join(MODULE, 'tests/fakes');
const VERSION = 'v1.37.1+k3s1';
const RUNSC = '20261012.0';
const MIRROR = 'https://mirror.test/node-artifacts';
const SSM = {
  join: '/blackwing/test/k3s/join-token',
  agent: '/blackwing/test/k3s/agent-token',
  kubeconfig: '/blackwing/test/k3s/kubeconfig',
  version: '/blackwing/test/k3s/server-version',
};
const FAKE_SECRETS = [
  'AKIAFAKEFAKEFAKE',
  'fake-secret-access-key',
  'fake-session-token',
  'imds-session-token',
];

/** @type {string[]} */
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** @param {string} algo @param {string | Buffer} data */
const digest = (algo, data) => createHash(algo).update(data).digest('hex');

/** @param {string} file */
const readOr = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** @param {string} text @returns {unknown} */
const parseJson = (text) => JSON.parse(text);

/**
 * @typedef {object} Node
 * @property {string} dir
 * @property {string} root
 * @property {string} state
 * @property {Record<string, string>} env
 * @property {(values: Record<string, string>) => void} seedSsm
 * @property {() => Record<string, {Value: string}>} ssm
 * @property {() => import('node:child_process').SpawnSyncReturns<string>} run
 */

/**
 * Builds a fake node: artifacts in the mirror, fakes on PATH, the env file the launch template
 * would write.
 * @param {{ role?: 'server' | 'agent', pool?: string, reportsVersion?: string, env?: Record<string, string>, nodeEnv?: Record<string, string> }} [opts]
 * @returns {Node}
 */
function makeNode(opts = {}) {
  const role = opts.role ?? 'server';
  const pool = opts.pool ?? (role === 'server' ? 'control-plane' : 'egress');
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-k3s-node-'));
  temps.push(dir);
  const root = path.join(dir, 'root');
  const state = path.join(dir, 'state');
  const bin = path.join(dir, 'bin');
  const artifacts = path.join(dir, 'artifacts');
  for (const d of [root, state, bin]) mkdirSync(d, { recursive: true });
  for (const fake of readdirSync(FAKES)) {
    copyFileSync(path.join(FAKES, fake), path.join(bin, fake));
    chmodSync(path.join(bin, fake), 0o755);
  }

  // The "k3s binary" reports its version and answers kubectl /readyz.
  const k3s = `#!/usr/bin/env bash\nif [[ "$1" == "--version" ]]; then echo "k3s version ${opts.reportsVersion ?? VERSION} (0123abcd)"; echo "go version go1.24"; exit 0; fi\nexit 0\n`;
  const airgap = randomBytes(64);
  const k3sDir = path.join(artifacts, 'mirror.test/node-artifacts/k3s', VERSION);
  mkdirSync(k3sDir, { recursive: true });
  writeFileSync(path.join(k3sDir, 'k3s'), k3s);
  writeFileSync(path.join(k3sDir, 'k3s-airgap-images-amd64.tar.zst'), airgap);

  const gvisorSrc = path.join(dir, 'gvisor-src');
  mkdirSync(gvisorSrc);
  writeFileSync(
    path.join(gvisorSrc, 'runsc'),
    '#!/bin/sh\necho "runsc version release-20261012.0"\n',
  );
  writeFileSync(path.join(gvisorSrc, 'containerd-shim-runsc-v1'), '#!/bin/sh\nexit 0\n');
  const gvisorDir = path.join(artifacts, 'mirror.test/node-artifacts/gvisor', RUNSC, 'x86_64');
  mkdirSync(gvisorDir, { recursive: true });
  const bundle = path.join(gvisorDir, 'gvisor.tar.bz2');
  const tar = spawnSync('tar', [
    '-cjf',
    bundle,
    '-C',
    gvisorSrc,
    'runsc',
    'containerd-shim-runsc-v1',
  ]);
  assert.equal(tar.status, 0, String(tar.stderr));

  /** @type {Record<string, string>} */
  const nodeEnv = {
    BW_NODE_ROLE: role,
    BW_POOL: pool,
    BW_K3S_VERSION: VERSION,
    BW_K3S_SHA256: digest('sha256', k3s),
    BW_K3S_AIRGAP_SHA256: digest('sha256', airgap),
    BW_K3S_BASE_URL: `${MIRROR}/k3s`,
    BW_INSTALL_RUNSC: pool === 'sandbox' ? 'true' : 'false',
    BW_RUNSC_VERSION: RUNSC,
    BW_RUNSC_SHA512: digest('sha512', readFileSync(bundle)),
    BW_RUNSC_BASE_URL: `${MIRROR}/gvisor`,
    BW_AWS_REGION: 'eu-central-1',
    BW_KMS_KEY_ARN:
      'arn:aws:kms:eu-central-1:123456789012:key/11111111-2222-3333-4444-555555555555',
    BW_SSM_JOIN_TOKEN: SSM.join,
    BW_SSM_AGENT_TOKEN: SSM.agent,
    BW_SSM_KUBECONFIG: SSM.kubeconfig,
    BW_SSM_SERVER_VERSION: SSM.version,
    BW_TOKEN_PLACEHOLDER: 'pending',
    BW_API_HOST: 'blackwing-test-k3s-api.elb.eu-central-1.amazonaws.com',
    BW_API_PORT: '6443',
    BW_LOG_GROUP: `/blackwing/blackwing-test/nodes/${pool}`,
    BW_MAX_ATTEMPTS: '5',
    BW_BACKOFF_BASE_SECONDS: '2',
    BW_BACKOFF_MAX_SECONDS: '60',
    ...opts.nodeEnv,
  };
  mkdirSync(path.join(root, 'etc/blackwing'), { recursive: true });
  writeFileSync(
    path.join(root, 'etc/blackwing/k3s-node.env'),
    Object.entries(nodeEnv)
      .map(([k, v]) => `${k}='${v}'`)
      .join('\n') + '\n',
  );

  const env = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: dir,
    TMPDIR: dir,
    BW_ROOT: root,
    BW_IMDS_URL: 'http://imds.test',
    FAKE_STATE: state,
    FAKE_ARTIFACTS: artifacts,
    ...opts.env,
  };
  const storePath = path.join(state, 'ssm.json');
  return {
    dir,
    root,
    state,
    env,
    seedSsm(values) {
      /** @type {Record<string, {Value: string}>} */
      const store = /** @type {Record<string, {Value: string}>} */ (
        existsSync(storePath) ? parseJson(readFileSync(storePath, 'utf8')) : {}
      );
      for (const [k, v] of Object.entries(values)) store[k] = { Value: v };
      writeFileSync(storePath, JSON.stringify(store));
    },
    ssm() {
      return /** @type {Record<string, {Value: string}>} */ (
        existsSync(storePath) ? parseJson(readFileSync(storePath, 'utf8')) : {}
      );
    },
    run() {
      return spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
    },
  };
}

/** @param {Node} node */
const sleeps = (node) =>
  readOr(path.join(node.state, 'sleep.log')).split('\n').filter(Boolean).map(Number);

/** @param {Node} node */
const started = (node) => readOr(path.join(node.state, 'started')).split('\n').filter(Boolean);

/** @param {Node} node */
const bootstrapLog = (node) => readOr(path.join(node.root, 'var/log/blackwing/k3s-bootstrap.log'));

/** @param {Node} node */
function shippedLogs(node) {
  return readOr(path.join(node.state, 'logs.jsonl'))
    .split('\n')
    .filter(Boolean)
    .map(
      (l) =>
        /** @type {{target: string, body: {logGroupName: string, logStreamName: string, logEvents?: {message: string}[]}}} */ (
          parseJson(l)
        ),
    );
}

/** @param {Node} node */
const putNames = (node) =>
  readOr(path.join(node.state, 'puts.jsonl'))
    .split('\n')
    .filter(Boolean)
    .map(
      (l) =>
        /** @type {{Name: string, Type: string, KeyId: string | null, Tier: string | null}} */ (
          parseJson(l)
        ),
    );

/**
 * Asserts that no secret value (tokens, AWS credentials) is in any process argv, the bootstrap
 * log, the shipped CloudWatch events or the console output.
 * @param {Node} node @param {import('node:child_process').SpawnSyncReturns<string>} res @param {string[]} secrets
 */
function assertNoSecretLeak(node, res, secrets) {
  const surfaces = {
    argv: readOr(path.join(node.state, 'calls.jsonl')),
    log: bootstrapLog(node),
    cloudwatch: readOr(path.join(node.state, 'logs.jsonl')),
    console: res.stdout + res.stderr,
    config: readOr(path.join(node.root, 'etc/rancher/k3s/config.yaml')),
  };
  for (const secret of [...secrets, ...FAKE_SECRETS]) {
    assert.ok(secret.length > 8);
    for (const [where, text] of Object.entries(surfaces)) {
      assert.ok(!text.includes(secret), `secret leaked into ${where}`);
    }
  }
}

describe('k3s node bootstrap: control plane', () => {
  it('generates both join tokens on the first boot, stores them as KMS SecureStrings and exports the kubeconfig', () => {
    const node = makeNode();
    node.seedSsm({ [SSM.join]: 'pending', [SSM.agent]: 'pending', [SSM.version]: 'pending' });
    const res = node.run();
    assert.equal(res.status, 0, res.stderr);

    const ssm = node.ssm();
    const server = ssm[SSM.join]?.Value ?? '';
    const agent = ssm[SSM.agent]?.Value ?? '';
    assert.match(server, /^[0-9a-f]{64}$/);
    assert.match(agent, /^[0-9a-f]{64}$/);
    assert.notEqual(server, agent, 'the agent token must differ from the server token');
    assert.equal(ssm[SSM.version]?.Value, VERSION, 'the server publishes its pinned version');

    const puts = putNames(node);
    for (const name of [SSM.join, SSM.agent, SSM.kubeconfig]) {
      const put = puts.find((p) => p.Name === name);
      assert.equal(put?.Type, 'SecureString');
      assert.match(put.KeyId ?? '', /^arn:aws:kms:/);
    }
    assert.equal(puts.find((p) => p.Name === SSM.kubeconfig)?.Tier, 'Advanced');

    const kubeconfig = ssm[SSM.kubeconfig]?.Value ?? '';
    assert.match(
      kubeconfig,
      /server: https:\/\/blackwing-test-k3s-api\.elb\.eu-central-1\.amazonaws\.com:6443/,
    );
    assert.ok(
      !kubeconfig.includes('127.0.0.1'),
      'the exported kubeconfig points at the internal API endpoint',
    );

    for (const f of ['server-token', 'agent-token']) {
      const file = path.join(node.root, 'etc/rancher/k3s', f);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    assert.equal(
      readFileSync(path.join(node.root, 'etc/rancher/k3s/server-token'), 'utf8'),
      server,
    );
    assert.deepEqual(started(node), ['k3s']);
    assert.match(
      readFileSync(path.join(node.root, 'etc/systemd/system/k3s.service'), 'utf8'),
      /ExecStart=\/usr\/local\/bin\/k3s server/,
    );
    assertNoSecretLeak(node, res, [server, agent]);
  });

  it('reuses the tokens already in SSM when a replacement control plane boots (no rotation, agents keep joining)', () => {
    const node = makeNode();
    const server = 'a'.repeat(64);
    const agent = 'b'.repeat(64);
    node.seedSsm({ [SSM.join]: server, [SSM.agent]: agent, [SSM.version]: VERSION });
    const res = node.run();
    assert.equal(res.status, 0, res.stderr);
    const tokenPuts = putNames(node).filter((p) => p.Name === SSM.join || p.Name === SSM.agent);
    assert.deepEqual(tokenPuts, [], 'existing tokens are never overwritten');
    assert.equal(readFileSync(path.join(node.root, 'etc/rancher/k3s/agent-token'), 'utf8'), agent);
    assert.match(bootstrapLog(node), /"event":"token_reused"/);
    assertNoSecretLeak(node, res, [server, agent]);
  });

  it('is idempotent: a re-run keeps the verified binaries and does not download again', () => {
    const node = makeNode();
    node.seedSsm({ [SSM.join]: 'pending', [SSM.agent]: 'pending', [SSM.version]: 'pending' });
    assert.equal(node.run().status, 0);
    const downloads = Number(readOr(path.join(node.state, 'download-calls')) || '0');
    const res = node.run();
    assert.equal(res.status, 0, res.stderr);
    assert.equal(Number(readOr(path.join(node.state, 'download-calls')) || '0'), downloads);
    assert.match(bootstrapLog(node), /"event":"artifact_present"/);
  });
});

describe('k3s node bootstrap: agents', () => {
  it('joins with the agent-only token and never reads the server token', () => {
    const node = makeNode({ role: 'agent', pool: 'egress' });
    const agent = 'c'.repeat(64);
    node.seedSsm({ [SSM.agent]: agent, [SSM.version]: VERSION, [SSM.join]: 'd'.repeat(64) });
    const res = node.run();
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(started(node), ['k3s-agent']);
    assert.equal(readFileSync(path.join(node.root, 'etc/rancher/k3s/agent-token'), 'utf8'), agent);
    assert.ok(!existsSync(path.join(node.root, 'etc/rancher/k3s/server-token')));
    const reads = readOr(path.join(node.state, 'gets.log')).split('\n').filter(Boolean);
    assert.ok(reads.includes(SSM.agent));
    assert.ok(!reads.includes(SSM.join), 'an agent must never ask for the server join token');
    assert.deepEqual(putNames(node), [], 'agents never write SSM');
    assertNoSecretLeak(node, res, [agent, 'd'.repeat(64)]);
  });

  it('installs the gVisor prerequisites (runsc + containerd shim) on sandbox nodes only', () => {
    const sandbox = makeNode({ role: 'agent', pool: 'sandbox' });
    sandbox.seedSsm({ [SSM.agent]: 'e'.repeat(64), [SSM.version]: VERSION });
    assert.equal(sandbox.run().status, 0);
    for (const bin of ['runsc', 'containerd-shim-runsc-v1']) {
      assert.equal(statSync(path.join(sandbox.root, 'usr/local/bin', bin)).mode & 0o777, 0o755);
    }
    const egress = makeNode({ role: 'agent', pool: 'egress' });
    egress.seedSsm({ [SSM.agent]: 'e'.repeat(64), [SSM.version]: VERSION });
    assert.equal(egress.run().status, 0);
    assert.ok(!existsSync(path.join(egress.root, 'usr/local/bin/runsc')));
  });

  it('blocks a version-drifted join: a server reporting another k3s version is refused and the failure is shipped', () => {
    const node = makeNode({ role: 'agent', pool: 'sandbox' });
    node.seedSsm({ [SSM.agent]: 'f'.repeat(64), [SSM.version]: 'v1.36.0+k3s1' });
    const res = node.run();
    assert.equal(res.status, 3);
    assert.deepEqual(started(node), [], 'k3s-agent must never start against a mismatched server');
    assert.ok(!existsSync(path.join(node.root, 'etc/rancher/k3s/agent-token')));
    assert.match(bootstrapLog(node), /"event":"version_mismatch"/);
    assert.match(bootstrapLog(node), /"event":"bootstrap_failed"/);
    const put = shippedLogs(node).find((l) => l.target === 'Logs_20140328.PutLogEvents');
    assert.equal(put?.body.logGroupName, '/blackwing/blackwing-test/nodes/sandbox');
    assert.equal(put.body.logStreamName, 'i-0123456789abcdef0/bootstrap');
    assert.ok(put.body.logEvents?.some((e) => e.message.includes('version_drift')));
  });

  it('waits for the control plane: a server that has not published its version yet is retried, not joined', () => {
    const node = makeNode({ role: 'agent', pool: 'egress', nodeEnv: { BW_MAX_ATTEMPTS: '3' } });
    node.seedSsm({ [SSM.agent]: 'pending', [SSM.version]: 'pending' });
    const res = node.run();
    assert.equal(res.status, 3);
    assert.deepEqual(sleeps(node), [2, 4]);
    assert.deepEqual(started(node), []);
  });

  it('refuses a node whose installed k3s binary reports another version than the pin', () => {
    const node = makeNode({ role: 'agent', reportsVersion: 'v1.36.9+k3s1' });
    node.seedSsm({ [SSM.agent]: 'g'.repeat(64), [SSM.version]: VERSION });
    const res = node.run();
    assert.equal(res.status, 3);
    assert.match(bootstrapLog(node), /"event":"version_drift"/);
    assert.deepEqual(started(node), []);
  });

  it('fails when the agent never becomes active (join failure surfaces in the logs)', () => {
    const node = makeNode({
      role: 'agent',
      env: { FAKE_NEVER_ACTIVE: 'k3s-agent' },
      nodeEnv: { BW_MAX_ATTEMPTS: '2' },
    });
    node.seedSsm({ [SSM.agent]: 'h'.repeat(64), [SSM.version]: VERSION });
    const res = node.run();
    assert.equal(res.status, 1);
    assert.match(bootstrapLog(node), /"event":"join_failed"/);
    assert.match(
      res.stderr,
      /bootstrap_failed/,
      'the failure is on the console (cloud-init output)',
    );
  });
});

describe('k3s node bootstrap: failure modes', () => {
  it('retries SSM with exponential backoff (network blip) and then succeeds', () => {
    const node = makeNode({ role: 'agent', env: { FAKE_SSM_FAIL_FIRST: '3' } });
    node.seedSsm({ [SSM.agent]: 'i'.repeat(64), [SSM.version]: VERSION });
    const res = node.run();
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(sleeps(node), [2, 4, 8]);
    assert.equal((bootstrapLog(node).match(/"event":"retry"/g) ?? []).length, 3);
  });

  it('caps the backoff delay', () => {
    const node = makeNode({
      role: 'agent',
      env: { FAKE_SSM_FAIL_FIRST: '6' },
      nodeEnv: { BW_MAX_ATTEMPTS: '10', BW_BACKOFF_MAX_SECONDS: '10' },
    });
    node.seedSsm({ [SSM.agent]: 'j'.repeat(64), [SSM.version]: VERSION });
    assert.equal(node.run().status, 0);
    assert.deepEqual(sleeps(node), [2, 4, 8, 10, 10, 10]);
  });

  it('waits for NTP before joining (clock skew would break TLS) and gives up after the retry budget', () => {
    const ok = makeNode({ role: 'agent', env: { FAKE_NTP_UNSYNCED: '2' } });
    ok.seedSsm({ [SSM.agent]: 'k'.repeat(64), [SSM.version]: VERSION });
    assert.equal(ok.run().status, 0);
    assert.deepEqual(sleeps(ok), [2, 4]);

    const skewed = makeNode({
      role: 'agent',
      env: { FAKE_NTP_UNSYNCED: '99' },
      nodeEnv: { BW_MAX_ATTEMPTS: '3' },
    });
    skewed.seedSsm({ [SSM.agent]: 'k'.repeat(64), [SSM.version]: VERSION });
    const res = skewed.run();
    assert.equal(res.status, 1);
    assert.match(bootstrapLog(skewed), /"event":"clock_unsynchronised"/);
    assert.ok(
      !existsSync(path.join(skewed.root, 'usr/local/bin/k3s')),
      'nothing is installed before the clock is synchronised',
    );
  });

  it('rejects a k3s download whose checksum does not match the pin and installs nothing', () => {
    const node = makeNode({ role: 'agent', nodeEnv: { BW_K3S_SHA256: '0'.repeat(64) } });
    node.seedSsm({ [SSM.agent]: 'l'.repeat(64), [SSM.version]: VERSION });
    const res = node.run();
    assert.equal(res.status, 1);
    assert.match(bootstrapLog(node), /"event":"checksum_mismatch"/);
    assert.ok(!existsSync(path.join(node.root, 'usr/local/bin/k3s')));
    assert.deepEqual(started(node), []);
  });

  it('retries a failed artifact download (mirror blip) and then installs it', () => {
    const node = makeNode({ role: 'agent', env: { FAKE_DOWNLOAD_FAIL_FIRST: '1' } });
    node.seedSsm({ [SSM.agent]: 'm'.repeat(64), [SSM.version]: VERSION });
    assert.equal(node.run().status, 0);
    assert.deepEqual(sleeps(node), [2]);
  });

  it('fails fast on a missing setting', () => {
    const node = makeNode({ nodeEnv: { BW_K3S_VERSION: '' } });
    const res = node.run();
    assert.equal(res.status, 2);
    assert.match(res.stderr, /BW_K3S_VERSION is not set/);
  });
});

describe('k3s version pins', () => {
  it('every environment pins the same k3s release and checksum as infra/k3s/versions.env', () => {
    const pins = readFileSync(path.join(REPO_ROOT, 'infra/k3s/versions.env'), 'utf8');
    const version = /^K3S_VERSION="([^"]+)"/m.exec(pins)?.[1];
    const sha = /^K3S_SHA256_AMD64="([^"]+)"/m.exec(pins)?.[1];
    const airgap = /^K3S_AIRGAP_SHA256_AMD64="([^"]+)"/m.exec(pins)?.[1];
    const runsc = readFileSync(path.join(REPO_ROOT, 'infra/versions.env'), 'utf8');
    const runscVersion = /^RUNSC_VERSION="([^"]+)"/m.exec(runsc)?.[1];
    const runscSha = /^RUNSC_SHA512_AMD64="([^"]+)"/m.exec(runsc)?.[1];
    assert.ok(version && sha && airgap && runscVersion && runscSha);
    for (const env of ['dev', 'staging', 'prod']) {
      const tfvars = readFileSync(
        path.join(REPO_ROOT, `infra/tofu/environments/${env}/terraform.tfvars`),
        'utf8',
      );
      assert.match(
        tfvars,
        new RegExp(`^k3s_version\\s*=\\s*"${version.replace(/[.+]/g, '\\$&')}"`, 'm'),
        env,
      );
      assert.match(tfvars, new RegExp(`^k3s_sha256\\s*=\\s*"${sha}"`, 'm'), env);
      assert.match(tfvars, new RegExp(`^k3s_airgap_images_sha256\\s*=\\s*"${airgap}"`, 'm'), env);
      assert.match(
        tfvars,
        new RegExp(`^runsc_version\\s*=\\s*"${runscVersion.replace(/\./g, '\\.')}"`, 'm'),
        env,
      );
      assert.match(tfvars, new RegExp(`^runsc_sha512\\s*=\\s*"${runscSha}"`, 'm'), env);
    }
  });
});
