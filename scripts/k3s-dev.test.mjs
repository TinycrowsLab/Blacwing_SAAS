// Self-tests for the dev k3s path (DEVENV-014): infra/k3s/install-dev.sh,
// infra/k3s/verify.sh and the manifests in infra/k3s.
//
// The manifest tests parse every YAML document and assert the §4.1 sandbox
// contract, then lint the manifests with kubeconform. The script tests run
// install-dev.sh against a simulated host: uname, nproc, id, sudo, systemctl,
// curl, kubectl, helm, runsc and k3s are shell mocks that record their calls,
// and every install lands under a throw-away BW_K3S_ROOT. Nothing touches the
// real host, a real cluster or the network (except kubeconform's schema cache).
// The live probes (verify.sh against a cluster) are the integration half; see
// docs/runbooks/dev-k3s.md.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAllDocuments } from 'yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const K3S = path.join(REPO, 'infra', 'k3s');
const INSTALL = path.join(K3S, 'install-dev.sh');
const VERIFY = path.join(K3S, 'verify.sh');

/** @param {string} file @returns {Record<string, string>} */
function readEnv(file) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)="(.*)"$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}
const HOST_V = readEnv(path.join(REPO, 'infra', 'versions.env'));
const V = readEnv(path.join(K3S, 'versions.env'));

/**
 * @typedef {{ apiVersion?: string, kind?: string, metadata?: { name?: string, namespace?: string,
 *   labels?: Record<string, string> }, spec?: unknown, handler?: string }} K8sDoc
 */
/**
 * Walks a dotted path ("spec.egress.0.to"; "\\." escapes a literal dot) through parsed YAML.
 * @param {unknown} o @param {string} p @returns {unknown}
 */
function at(o, p) {
  let cur = o;
  for (const key of p.split(/(?<!\\)\./).map((k) => k.replaceAll('\\.', '.'))) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = /** @type {Record<string, unknown>} */ (cur)[key];
  }
  return cur;
}
/** @param {unknown} o @param {string} p @returns {unknown[]} */
function arr(o, p) {
  const v = at(o, p);
  assert.ok(Array.isArray(v), `${p} must be a list`);
  return v;
}
/** @param {string} rel @returns {K8sDoc[]} */
function docs(rel) {
  return parseAllDocuments(fs.readFileSync(path.join(K3S, rel), 'utf8')).map((d) => {
    assert.equal(d.errors.length, 0, `${rel}: ${String(d.errors[0])}`);
    /** @type {unknown} */
    const js = d.toJS();
    return /** @type {K8sDoc} */ (js);
  });
}
/** @param {K8sDoc[]} all @param {string} kind @param {string} name @returns {K8sDoc} */
function find(all, kind, name) {
  const d = all.find((x) => x.kind === kind && x.metadata?.name === name);
  assert.ok(d, `${kind}/${name} not found`);
  return d;
}

const MANIFEST_FILES = [
  ...fs.readdirSync(path.join(K3S, 'manifests')).map((f) => `manifests/${f}`),
  'examples/sandbox-pod.yaml',
  'k3d/runtimeclass-runc.yaml',
];
const ALL = MANIFEST_FILES.flatMap((f) => docs(f));

describe('infra/k3s versions', () => {
  it('pins k3s, its checksums and digest-pinned images', () => {
    assert.match(V.K3S_VERSION ?? '', /^v\d+\.\d+\.\d+\+k3s\d+$/);
    assert.match(V.K3S_SHA256_AMD64 ?? '', /^[0-9a-f]{64}$/);
    assert.match(V.K3S_SHA256_ARM64 ?? '', /^[0-9a-f]{64}$/);
    const tag = (V.K3S_VERSION ?? '').replace('+', '-');
    assert.ok(
      V.K3S_IMAGE?.startsWith(`rancher/k3s:${tag}@sha256:`),
      'k3d image must be the same k3s release',
    );
    for (const k of ['K3S_IMAGE', 'K3S_PAUSE_IMAGE', 'PROBE_IMAGE']) {
      assert.match(V[k] ?? '', /@sha256:[0-9a-f]{64}$/, `${k} must be pinned by digest`);
    }
  });

  it('every image in the manifests is the pinned probe image', () => {
    const images = MANIFEST_FILES.flatMap((f) =>
      [...fs.readFileSync(path.join(K3S, f), 'utf8').matchAll(/image:\s*(\S+)/g)].map((m) => m[1]),
    );
    assert.ok(images.length >= 5);
    for (const img of images) assert.equal(img, V.PROBE_IMAGE);
  });
});

describe('gvisor RuntimeClass', () => {
  it('maps gvisor to the runsc handler', () => {
    const rc = find(docs('manifests/00-runtimeclass.yaml'), 'RuntimeClass', 'gvisor');
    assert.equal(rc.apiVersion, 'node.k8s.io/v1');
    assert.equal(rc.handler, 'runsc');
  });

  it('the k3d substitute keeps the name, is marked, and links its porting issue', () => {
    const src = fs.readFileSync(path.join(K3S, 'k3d/runtimeclass-runc.yaml'), 'utf8');
    const rc = find(docs('k3d/runtimeclass-runc.yaml'), 'RuntimeClass', 'gvisor');
    assert.equal(rc.handler, 'runc');
    assert.equal(rc.metadata?.labels?.['blackwing.io/k3d-substitute'], 'true');
    assert.match(src, /OFFLINE-STUB\(online-porting #\d+\)/);
  });

  it('containerd registers runsc on top of the k3s base template', () => {
    const tmpl = fs.readFileSync(path.join(K3S, 'host/config-v3.toml.tmpl'), 'utf8');
    assert.match(tmpl, /^\{\{ template "base" \. \}\}/);
    assert.match(
      tmpl,
      /\[plugins\.'io\.containerd\.cri\.v1\.runtime'\.containerd\.runtimes\.runsc\]/,
    );
    assert.match(tmpl, /runtime_type = "io\.containerd\.runsc\.v1"/);
  });

  it('k3s keeps NetworkPolicy enforcement and a pod pids limit', () => {
    const cfg = fs.readFileSync(path.join(K3S, 'host/config.yaml'), 'utf8');
    assert.doesNotMatch(cfg, /^\s*disable-network-policy/m);
    assert.match(cfg, /pod-max-pids=\d+/);
    assert.match(cfg, /write-kubeconfig-mode: ['"]0600['"]/);
  });
});

describe('sandbox namespace and admission guard', () => {
  it('enforces Pod Security restricted and carries the sandbox label', () => {
    const ns = find(ALL, 'Namespace', 'sandbox');
    assert.equal(ns.metadata?.labels?.['pod-security.kubernetes.io/enforce'], 'restricted');
    assert.equal(ns.metadata.labels['blackwing.io/sandbox'], 'true');
  });

  it('the ValidatingAdmissionPolicy fails closed and covers hostPath, runtime class and hardening', () => {
    const vap = find(ALL, 'ValidatingAdmissionPolicy', 'blackwing-sandbox-guard');
    assert.equal(at(vap, 'spec.failurePolicy'), 'Fail');
    assert.deepEqual(at(vap, 'spec.matchConstraints.resourceRules.0.resources'), [
      'pods',
      'pods/ephemeralcontainers',
    ]);
    const exprs = arr(vap, 'spec.validations')
      .map((v) => String(at(v, 'expression')))
      .join('\n');
    for (const needle of [
      '!has(v.hostPath)',
      "object.spec.runtimeClassName == 'gvisor'",
      'object.spec.hostNetwork',
      'object.spec.hostPID',
      'automountServiceAccountToken == false',
      'readOnlyRootFilesystem == true',
      'allowPrivilegeEscalation == false',
      "x == 'ALL'",
      "'memory' in c.resources.limits",
    ]) {
      assert.ok(exprs.includes(needle), `admission guard lacks ${needle}`);
    }
    assert.match(String(at(vap, 'spec.variables.0.expression')), /ephemeralContainers/);
    const binding = find(ALL, 'ValidatingAdmissionPolicyBinding', 'blackwing-sandbox-guard');
    assert.deepEqual(at(binding, 'spec.validationActions'), ['Deny']);
    assert.deepEqual(at(binding, 'spec.matchResources.namespaceSelector.matchLabels'), {
      'blackwing.io/sandbox': 'true',
    });
  });

  it('no manifest mounts a hostPath or the host container socket', () => {
    for (const f of MANIFEST_FILES) {
      const src = fs.readFileSync(path.join(K3S, f), 'utf8');
      assert.doesNotMatch(src, /^\s*hostPath:/m, f);
      assert.doesNotMatch(src, /mountPath:\s*\S*\.sock/, f);
    }
  });
});

describe('sample sandbox Pod (§4.1 contract)', () => {
  const pod = find(ALL, 'Pod', 'sandbox-example');
  const c = at(pod, 'spec.containers.0');

  it('runs under gvisor, non-root, with seccomp and no API token', () => {
    assert.equal(pod.metadata?.namespace, 'sandbox');
    assert.equal(at(pod, 'spec.runtimeClassName'), 'gvisor');
    for (const k of [
      'automountServiceAccountToken',
      'enableServiceLinks',
      'hostNetwork',
      'hostPID',
      'hostIPC',
    ]) {
      assert.equal(at(pod, `spec.${k}`), false, k);
    }
    assert.equal(at(pod, 'spec.securityContext.runAsNonRoot'), true);
    assert.ok(Number(at(pod, 'spec.securityContext.runAsUser')) > 0);
    assert.equal(at(pod, 'spec.securityContext.seccompProfile.type'), 'RuntimeDefault');
  });

  it('drops ALL capabilities, read-only rootfs, no-new-privileges, limits', () => {
    assert.deepEqual(at(c, 'securityContext.capabilities.drop'), ['ALL']);
    assert.equal(at(c, 'securityContext.readOnlyRootFilesystem'), true);
    assert.equal(at(c, 'securityContext.allowPrivilegeEscalation'), false);
    assert.equal(at(c, 'securityContext.privileged'), false);
    for (const k of ['cpu', 'memory', 'ephemeral-storage']) {
      assert.ok(at(c, `resources.limits.${k}`), `limit ${k}`);
    }
  });

  it('has a size-limited tmpfs workspace', () => {
    const ws = arr(pod, 'spec.volumes').find((v) => at(v, 'name') === 'workspace');
    assert.equal(at(ws, 'emptyDir.medium'), 'Memory');
    assert.ok(at(ws, 'emptyDir.sizeLimit'));
    assert.ok(arr(c, 'volumeMounts').some((m) => at(m, 'mountPath') === '/workspace'));
  });

  it('has no resolver (DNS is not an allowed destination)', () => {
    assert.equal(at(pod, 'spec.dnsPolicy'), 'None');
    assert.deepEqual(at(pod, 'spec.dnsConfig.nameservers'), ['127.0.0.1']);
  });
});

describe('sandbox NetworkPolicy', () => {
  it('default-denies ingress and egress for every sandbox pod', () => {
    const deny = find(ALL, 'NetworkPolicy', 'default-deny-all');
    assert.equal(deny.metadata?.namespace, 'sandbox');
    assert.deepEqual(at(deny, 'spec.podSelector'), {});
    assert.deepEqual(at(deny, 'spec.policyTypes'), ['Ingress', 'Egress']);
    assert.equal(at(deny, 'spec.ingress'), undefined);
    assert.equal(at(deny, 'spec.egress'), undefined);
  });

  it('allows egress only to the three §4.1 destinations, one port each, no ipBlock', () => {
    const allow = find(ALL, 'NetworkPolicy', 'sandbox-egress-allowlist');
    assert.equal(at(allow, 'spec.ingress'), undefined);
    const rules = arr(allow, 'spec.egress');
    assert.equal(rules.length, 3);
    /** @type {Record<string, unknown>} */
    const got = {};
    for (const r of rules) {
      assert.equal(arr(r, 'to').length, 1);
      const peer = at(r, 'to.0');
      assert.equal(
        at(peer, 'ipBlock'),
        undefined,
        'no ipBlock: metadata/internet must stay unreachable',
      );
      assert.deepEqual(at(peer, 'namespaceSelector.matchLabels'), {
        'kubernetes.io/metadata.name': 'bw-system',
      });
      assert.equal(arr(r, 'ports').length, 1);
      assert.equal(at(r, 'ports.0.protocol'), 'TCP');
      got[String(at(peer, 'podSelector.matchLabels.app\\.kubernetes\\.io/name'))] = at(
        r,
        'ports.0.port',
      );
    }
    assert.deepEqual(got, { 'egress-gateway': 13128, 'model-gateway': 13500, 'run-broker': 13400 });
  });

  it('the dev placeholders listen on exactly the allowed ports', () => {
    for (const [name, port] of /** @type {const} */ ([
      ['egress-gateway', 13128],
      ['model-gateway', 13500],
      ['run-broker', 13400],
    ])) {
      const dep = find(ALL, 'Deployment', name);
      assert.equal(dep.metadata?.namespace, 'bw-system');
      assert.equal(at(dep, 'spec.template.spec.containers.0.ports.0.containerPort'), port);
    }
    assert.equal(find(ALL, 'Deployment', 'outside-http').metadata?.namespace, 'bw-dev-outside');
  });
});

describe('kubeconform', () => {
  it('validates every manifest strictly against the Kubernetes schemas', () => {
    const cache = path.join(os.tmpdir(), 'bw-kubeconform-cache');
    fs.mkdirSync(cache, { recursive: true });
    const r = spawnSync(
      'kubeconform',
      ['-strict', '-summary', '-cache', cache, '-kubernetes-version', '1.33.0', ...MANIFEST_FILES],
      { cwd: K3S, encoding: 'utf8' },
    );
    assert.equal(
      r.error,
      undefined,
      'kubeconform must be installed (see docs/runbooks/dev-k3s.md)',
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Invalid: 0, Errors: 0, Skipped: 0/);
  });
});

// ------------------------------------------------------------ script tests --

const REAL = [
  'bash',
  'sh',
  'env',
  'cat',
  'cp',
  'rm',
  'mkdir',
  'install',
  'chmod',
  'cmp',
  'cut',
  'sed',
  'grep',
  'head',
  'tail',
  'tr',
  'awk',
  'sha256sum',
  'mktemp',
  'dirname',
  'basename',
  'tar',
  'jq',
  'sleep',
  'touch',
  'test',
];
/** @type {string[]} */
const hosts = [];
/** @type {string} */
let K3S_FIXTURE = '';
/** @type {string} */
let K3S_SHA = '';

before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-k3s-fx-'));
  hosts.push(dir);
  K3S_FIXTURE = path.join(dir, 'k3s');
  // The "downloaded" k3s binary is a mock that reports the pinned version and
  // answers `crictl info` according to $FAKE_STATE/runsc-registered.
  fs.writeFileSync(
    K3S_FIXTURE,
    `#!/bin/sh
echo "k3s $*" >>"$FAKE_STATE/calls"
case "$1" in
  --version) echo "k3s version ${V.K3S_VERSION} (deadbeef)"; echo "go version go1.24";;
  crictl) if [ -f "$FAKE_STATE/runsc-registered" ]; then echo '{"config":{"containerd":{"runtimes":{"runc":{},"runsc":{"runtimeType":"io.containerd.runsc.v1"}}}}}'; else echo '{"config":{"containerd":{"runtimes":{"runc":{}}}}}'; fi;;
esac
`,
  );
  K3S_SHA = createHash('sha256').update(fs.readFileSync(K3S_FIXTURE)).digest('hex');
});
after(() => {
  for (const d of hosts) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * @param {{ kernel?: string, cpus?: number, memKb?: number, wsl?: boolean, runsc?: string | null,
 *   shim?: boolean, registered?: boolean, k3sConfig?: string }} [o]
 */
function makeHost(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-k3s-host-'));
  hosts.push(dir);
  const bin = path.join(dir, 'bin');
  const root = path.join(dir, 'root');
  const state = path.join(dir, 'state');
  for (const d of [
    bin,
    root,
    state,
    path.join(root, 'usr/local/bin'),
    path.join(root, 'etc/rancher/k3s'),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const t of REAL) {
    const p = execFileSync('bash', ['-c', `type -P ${t} || true`], { encoding: 'utf8' }).trim();
    if (p) fs.symlinkSync(p, path.join(bin, t));
  }
  /** @param {string} name @param {string} body */
  const mock = (name, body) => {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\necho "${name} $*" >>"$FAKE_STATE/calls"\n${body}\n`,
    );
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  mock(
    'uname',
    `case "$1" in -m) echo x86_64;; -r) echo "${o.kernel ?? '6.8.0-1015-aws'}";; *) echo Linux;; esac`,
  );
  mock('nproc', `echo ${o.cpus ?? 8}`);
  mock('id', 'echo 0');
  mock('sudo', '"$@"');
  mock('systemctl', 'exit 0');
  mock(
    'curl',
    `while [ $# -gt 0 ]; do [ "$1" = -o ] && { cp "${K3S_FIXTURE}" "$2"; chmod 755 "$2"; }; shift; done`,
  );
  mock('kubectl', 'exit 0');
  mock('helm', `echo "v${HELM_VERSION}"`);
  if (o.runsc !== null)
    mock('runsc', `echo "runsc version release-${o.runsc ?? HOST_V.RUNSC_VERSION}"`);
  if (o.shim !== false) mock('containerd-shim-runsc-v1', 'exit 0');
  fs.writeFileSync(path.join(dir, 'meminfo'), `MemTotal:       ${o.memKb ?? 16_000_000} kB\n`);
  fs.writeFileSync(
    path.join(dir, 'version'),
    o.wsl ? 'Linux version 6.6.87.2-microsoft-standard-WSL2\n' : 'Linux version 6.8.0\n',
  );
  if (o.registered !== false) fs.writeFileSync(path.join(state, 'runsc-registered'), '');
  if (o.k3sConfig !== undefined)
    fs.writeFileSync(path.join(root, 'etc/rancher/k3s/config.yaml'), o.k3sConfig);
  fs.writeFileSync(path.join(root, 'etc/rancher/k3s/k3s.yaml'), 'apiVersion: v1\nkind: Config\n');
  const versions = path.join(dir, 'k3s-versions.env');
  fs.writeFileSync(
    versions,
    fs
      .readFileSync(path.join(K3S, 'versions.env'), 'utf8')
      .replace(/^K3S_SHA256_AMD64=.*$/m, `K3S_SHA256_AMD64="${K3S_SHA}"`),
  );
  /** @param {string[]} args @param {Record<string, string>} [env] */
  const run = (args, env = {}) =>
    spawnSync(path.join(bin, 'bash'), [INSTALL, ...args], {
      encoding: 'utf8',
      env: {
        PATH: bin,
        HOME: dir,
        FAKE_STATE: state,
        BW_K3S_ROOT: root,
        BW_K3S_VERSIONS_FILE: versions,
        BW_K3S_MEMINFO: path.join(dir, 'meminfo'),
        BW_K3S_PROC_VERSION: path.join(dir, 'version'),
        BW_K3S_KUBECONFIG: path.join(dir, 'kube', 'config'),
        ...env,
      },
    });
  const calls = () =>
    fs.existsSync(path.join(state, 'calls'))
      ? fs.readFileSync(path.join(state, 'calls'), 'utf8')
      : '';
  return { dir, root, state, run, calls };
}
const HELM_VERSION = HOST_V.HELM_VERSION ?? '';

describe('infra/k3s/install-dev.sh', () => {
  it('--help prints usage', () => {
    const r = makeHost().run(['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /install-dev\.sh --k3d/);
    assert.match(r.stdout, /BW_K3S_SKIP=1/);
  });

  it('rejects unknown arguments', () => {
    const r = makeHost().run(['--bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown argument/);
  });

  it('BW_K3S_SKIP=1 skips the k3s path in favour of Docker + runsc', () => {
    const h = makeHost({ cpus: 1 });
    const r = h.run([], { BW_K3S_SKIP: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Docker \+ runsc/);
    assert.equal(h.calls(), '');
  });

  it('edge: a small laptop fails with the minimum resources and the skip remediation', () => {
    for (const o of [{ cpus: 2 }, { memKb: 4_000_000 }]) {
      const r = makeHost(o).run(['--dry-run']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /needs >= 4 CPUs and >= 7680 MiB/);
      assert.match(r.stderr, /BW_K3S_SKIP=1/);
    }
  });

  it('edge: a kernel without gVisor support fails with remediation', () => {
    for (const kernel of ['4.14.76-generic', '3.10.0']) {
      const r = makeHost({ kernel }).run(['--dry-run']);
      assert.equal(r.status, 1, kernel);
      assert.match(r.stderr, /lacks gVisor support \(runsc needs Linux >= 4\.14\.77\)/);
      assert.match(r.stderr, /linux-generic-hwe-24\.04/);
    }
    assert.equal(makeHost({ kernel: '4.14.77' }).run(['--dry-run']).status, 0);
  });

  it('edge: a WSL2 kernel is refused and points at --k3d / Docker + runsc', () => {
    const r = makeHost({ wsl: true }).run(['--dry-run']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /WSL2 kernel detected/);
    assert.match(r.stderr, /--k3d/);
  });

  it('edge: runsc missing, its shim missing or a drifted version is a clear error', () => {
    let r = makeHost({ runsc: null }).run(['--dry-run']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /runsc not found on PATH: run infra\/bootstrap\.sh/);
    r = makeHost({ shim: false }).run(['--dry-run']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /containerd-shim-runsc-v1 not found/);
    r = makeHost({ runsc: '20200101.0' }).run(['--dry-run']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match the pin/);
  });

  it('edge: refuses a k3s config that disables NetworkPolicy enforcement', () => {
    for (const k3sConfig of [
      'disable-network-policy: true\n',
      "disable-network-policy: 'true'\n",
    ]) {
      const r = makeHost({ k3sConfig }).run(['--dry-run']);
      assert.equal(r.status, 1, k3sConfig);
      assert.match(r.stderr, /disable-network-policy: sandbox NetworkPolicy would not be enforced/);
    }
  });

  it('--dry-run reports every pending change and writes nothing', () => {
    const h = makeHost();
    const r = h.run(['--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    for (const what of [
      'etc/rancher/k3s/config.yaml',
      'config-v3.toml.tmpl',
      'k3s.service',
      `k3s missing -> ${V.K3S_VERSION}`,
    ]) {
      assert.ok(
        r.stderr.includes(`would change: `) && r.stderr.includes(what),
        `${what}\n${r.stderr}`,
      );
    }
    assert.equal(fs.existsSync(path.join(h.root, 'etc/rancher/k3s/config.yaml')), false);
    assert.equal(fs.existsSync(path.join(h.root, 'usr/local/bin/k3s')), false);
    assert.doesNotMatch(h.calls(), /^(systemctl|curl|kubectl) /m);
  });

  it('installs k3s, the runsc handler config and manifests, and is idempotent', () => {
    const h = makeHost();
    let r = h.run(['--no-verify']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.readFileSync(
        path.join(h.root, 'var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl'),
        'utf8',
      ),
      fs.readFileSync(path.join(K3S, 'host/config-v3.toml.tmpl'), 'utf8'),
    );
    assert.equal(
      fs.readFileSync(path.join(h.root, 'etc/rancher/k3s/config.yaml'), 'utf8'),
      fs.readFileSync(path.join(K3S, 'host/config.yaml'), 'utf8'),
    );
    assert.ok(fs.existsSync(path.join(h.root, 'etc/systemd/system/k3s.service')));
    assert.equal(fs.statSync(path.join(h.dir, 'kube', 'config')).mode & 0o777, 0o600);
    const calls = h.calls();
    assert.match(calls, /^systemctl restart k3s$/m);
    assert.match(calls, /^k3s crictl info$/m);
    assert.match(calls, /kubectl .*--context bw-dev apply -f .*00-runtimeclass\.yaml/);
    assert.match(calls, /kubectl .*apply -f .*30-networkpolicy\.yaml/);
    assert.doesNotMatch(calls, /runtimeclass-runc/);
    r = h.run(['--no-verify']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /changed:/, 'second run must change nothing');
  });

  it('edge: runsc not registered with containerd fails with a clear error', () => {
    const r = makeHost({ registered: false }).run(['--no-verify']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /runsc is not registered with k3s containerd/);
    assert.match(r.stderr, /crictl info/);
  });

  it('a k3s download with the wrong checksum is refused', () => {
    const h = makeHost();
    const bad = path.join(h.dir, 'bad.env');
    fs.writeFileSync(
      bad,
      fs
        .readFileSync(path.join(K3S, 'versions.env'), 'utf8')
        .replace(/^K3S_SHA256_AMD64=.*$/m, `K3S_SHA256_AMD64="${'0'.repeat(64)}"`),
    );
    const r = h.run(['--no-verify'], { BW_K3S_VERSIONS_FILE: bad });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /checksum mismatch for k3s/);
    assert.equal(fs.existsSync(path.join(h.root, 'usr/local/bin/k3s')), false);
  });
});

describe('infra/k3s/verify.sh', () => {
  /**
   * A cluster that does NOT enforce anything: admission admits everything,
   * every connection from the sandbox succeeds and the runtime is runc.
   * verify.sh must fail loudly instead of passing.
   */
  it('edge: an unenforced cluster (no policy CNI, no admission, runc) fails', () => {
    const h = makeHost();
    const bin = path.join(h.dir, 'bin');
    fs.writeFileSync(
      path.join(bin, 'kubectl'),
      `#!/bin/sh
case "$*" in
  *"get runtimeclass"*) printf runc;;
  *"get pod"*"-o jsonpath"*) printf 'RuntimeDefault false ALL 500m 256Mi';;
  *"get svc"*) printf 10.43.0.10;;
  *"get nodes"*) printf 172.31.0.2;;
  *"dmesg"*) echo "[0.0] Linux version 6.8";;
  *"id -u"*) exit 0;;
esac
exit 0
`,
    );
    const r = spawnSync(path.join(bin, 'bash'), [VERIFY, '--kubeconfig', '/dev/null'], {
      encoding: 'utf8',
      env: { PATH: bin, HOME: h.dir },
    });
    assert.equal(r.status, 1, r.stdout);
    for (const line of [
      "FAIL  runtimeclass gvisor missing or wrong handler 'runc'",
      'FAIL  admission rejects hostPath mount of /var/run/docker.sock',
      'FAIL  admission rejects a pod without runtimeClassName gvisor',
      'FAIL  dmesg inside the sandbox does not show gVisor',
      'FAIL  egress blocked: cloud metadata 169.254.169.254',
      'FAIL  egress blocked: cloud metadata IPv6 [fd00:ec2::254]',
      'FAIL  egress blocked: internet 1.1.1.1',
      'FAIL  host socket /var/run/docker.sock is absent inside the sandbox',
    ]) {
      assert.ok(r.stdout.includes(line), `missing "${line}"\n${r.stdout}`);
    }
    assert.doesNotMatch(r.stdout, /NOT VERIFIED/);
  });

  it('--k3d reports the gVisor checks as NOT VERIFIED, never as passed', () => {
    const src = fs.readFileSync(VERIFY, 'utf8');
    assert.match(src, /unverified "gVisor kernel inside the sandbox/);
    assert.doesNotMatch(src, /pass "[^"]*gVisor[^"]*"[^\n]*K3D/);
  });

  it('rejects unknown arguments', () => {
    const r = spawnSync('bash', [VERIFY, '--nope'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
  });
});

describe('infra/k3s scripts lint', () => {
  it('pass shellcheck', () => {
    const r = spawnSync('shellcheck', ['-x', 'infra/k3s/install-dev.sh', 'infra/k3s/verify.sh'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    assert.equal(r.error, undefined, 'shellcheck must be installed');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it('are bash with strict mode and never bind the host socket', () => {
    for (const f of [INSTALL, VERIFY]) {
      const src = fs.readFileSync(f, 'utf8');
      assert.match(src, /^#!\/usr\/bin\/env bash\n/);
      assert.match(src, /^set -euo pipefail$/m);
      assert.doesNotMatch(src, /docker\.sock:/);
      assert.ok((fs.statSync(f).mode & 0o111) !== 0, `${f} must be executable`);
    }
  });
});
