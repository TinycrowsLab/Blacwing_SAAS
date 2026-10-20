// Self-tests for infra/bootstrap.sh (DEVENV-001).
//
// The script runs against a simulated Ubuntu 24.04 host: privileged and system
// commands (sudo, apt-get, dpkg-query, systemctl, usermod, docker, curl, gpg,
// uname, id) are shell mocks that record their calls, every download is a
// local fixture with its own checksum, and every install lands under a
// throw-away BW_BOOTSTRAP_ROOT. Nothing touches the real host or the network.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'infra', 'bootstrap.sh');
const VERSIONS = path.join(REPO, 'infra', 'versions.env');

/** @param {string} cmd */
function which(cmd) {
  return execFileSync('bash', ['-c', `type -P ${cmd}`], { encoding: 'utf8' }).trim();
}

const BASH = which('bash');
const REAL_JQ = which('jq');
const REAL_TOOLS = [
  'bash',
  'sh',
  'env',
  'cat',
  'cp',
  'mv',
  'rm',
  'mkdir',
  'ln',
  'readlink',
  'touch',
  'chmod',
  'install',
  'tar',
  'xz',
  'bzip2',
  'gzip',
  'sha256sum',
  'sha512sum',
  'cut',
  'sed',
  'tr',
  'awk',
  'head',
  'tail',
  'grep',
  'sort',
  'paste',
  'date',
  'mktemp',
  'dirname',
  'basename',
  'wc',
  'true',
  'false',
];

/** @returns {Record<string, string>} */
function parseVersions() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of fs.readFileSync(VERSIONS, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)="([^"]*)"$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}
const V = parseVersions();

/**
 * @param {string} file
 * @returns {unknown}
 */
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** @param {string} url */
const urlKey = (url) => url.replace(/^https:\/\//, '').replaceAll('/', '_');

/**
 * @param {string} file
 * @param {string} body
 */
function writeExec(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** @param {string} file @param {'sha256' | 'sha512'} algo */
const digest = (file, algo) => createHash(algo).update(fs.readFileSync(file)).digest('hex');

const MOCKS = {
  uname: `case "$1" in -m) echo "\${FAKE_ARCH:-x86_64}";; -r) echo "\${FAKE_KERNEL:-6.8.0-45-generic}";; *) echo Linux;; esac`,
  id: `case "$1" in
  -u) echo "\${FAKE_UID:-1000}";;
  -un) echo "\${FAKE_USER:-dev}";;
  -nG) if [ -n "$2" ]; then cat "$FAKE_STATE/groups-$2" 2>/dev/null || echo "$2"; else cat "$FAKE_STATE/session-groups"; fi;;
esac`,
  sudo: `if [ "$1" = "-n" ]; then shift; [ -f "$FAKE_STATE/sudo-needs-password" ] && exit 1; fi
[ "$1" = "-v" ] && exit 0
echo "sudo $*" >> "$FAKE_STATE/calls"
exec "$@"`,
  curl: `out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; --connect-timeout|--retry) shift;; -*) ;; *) url="$1";; esac; shift; done
echo "curl $url" >> "$FAKE_STATE/calls"
n=$(cat "$FAKE_STATE/curl-fail" 2>/dev/null || echo 0)
if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAKE_STATE/curl-fail"; exit 22; fi
key=$(echo "$url" | sed -e 's|^https://||' -e 's|/|_|g')
[ -f "$FAKE_DL/$key" ] || exit 22
cp "$FAKE_DL/$key" "$out"`,
  gpg: `echo "fpr:::::::::$(cat "$FAKE_STATE/gpg-fpr"):"`,
  'apt-get': `echo "apt-get $*" >> "$FAKE_STATE/calls"
if [ "$1" = install ]; then for a in "$@"; do case "$a" in *=*) echo "\${a#*=}" > "$FAKE_STATE/dpkg/\${a%%=*}";; esac; done; fi`,
  'apt-mark': `echo "apt-mark $*" >> "$FAKE_STATE/calls"`,
  'dpkg-query': `for a in "$@"; do pkg="$a"; done
[ -f "$FAKE_STATE/dpkg/$pkg" ] || exit 1
printf 'install ok installed|%s' "$(cat "$FAKE_STATE/dpkg/$pkg")"`,
  systemctl: `echo "systemctl $*" >> "$FAKE_STATE/calls"
case "$1" in is-active) [ -f "$FAKE_STATE/docker-active" ];; enable) touch "$FAKE_STATE/docker-active";; esac`,
  usermod: `echo "usermod $*" >> "$FAKE_STATE/calls"
for u in "$@"; do user="$u"; done
echo "$(cat "$FAKE_STATE/groups-$user" 2>/dev/null || echo "$user") docker" > "$FAKE_STATE/groups-$user"`,
  docker: `echo "docker $*" >> "$FAKE_STATE/calls"
case "$1" in
  info) [ ! -f "$FAKE_STATE/docker-no-access" ];;
  ps) cat "$FAKE_STATE/containers" 2>/dev/null || true;;
  inspect) cat "$FAKE_STATE/inspect" 2>/dev/null || true;;
  run) [ -f "$FAKE_STATE/runsc-broken" ] && exit 125; echo "Hello from Docker!";;
esac`,
  sleep: `echo "sleep $*" >> "$FAKE_STATE/calls"`,
};

let FIXTURES = '';
/** @type {Record<string, string>} */
const SUMS = {};

/** Builds one set of download fixtures per arch and records their checksums. */
function buildFixtures() {
  FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-bootstrap-fx-'));
  const dl = path.join(FIXTURES, 'dl');
  fs.mkdirSync(dl);
  /** @type {Array<[string, string, string]>} */
  const arches = [
    ['amd64', 'x86_64', 'x64'],
    ['arm64', 'aarch64', 'arm64'],
  ];
  for (const [arch, garch, narch] of arches) {
    const A = arch.toUpperCase();
    const work = path.join(FIXTURES, `work-${arch}`);
    /** @param {string} url @param {string} file @param {string} sumKey @param {'sha256'|'sha512'} algo */
    const put = (url, file, sumKey, algo) => {
      fs.copyFileSync(file, path.join(dl, urlKey(url)));
      SUMS[`${sumKey}_${A}`] = digest(file, algo);
    };
    /** @param {string} name @param {string} body */
    const single = (name, body) => {
      const f = path.join(work, 'single', name);
      writeExec(f, body);
      return f;
    };
    /** @param {string} name @param {string} flag @param {Record<string, string>} files */
    const tarball = (name, flag, files) => {
      const dir = path.join(work, name + '.d');
      for (const [rel, body] of Object.entries(files)) writeExec(path.join(dir, rel), body);
      const out = path.join(work, name);
      execFileSync('tar', [flag, out, '-C', dir, '.']);
      return out;
    };

    put(
      `https://github.com/jqlang/jq/releases/download/jq-${V.JQ_VERSION}/jq-linux-${arch}`,
      single(
        `jq-${arch}`,
        `[ "$1" = --version ] && { echo "jq-${V.JQ_VERSION}"; exit 0; }\nexec ${REAL_JQ} "$@"`,
      ),
      'JQ_SHA256',
      'sha256',
    );
    put(
      `https://github.com/FiloSottile/mkcert/releases/download/v${V.MKCERT_VERSION}/mkcert-v${V.MKCERT_VERSION}-linux-${arch}`,
      single(`mkcert-${arch}`, `echo "v${V.MKCERT_VERSION}"`),
      'MKCERT_SHA256',
      'sha256',
    );
    put(
      `https://dl.k8s.io/release/v${V.KUBECTL_VERSION}/bin/linux/${arch}/kubectl`,
      single(
        `kubectl-${arch}`,
        `echo "Client Version: v${V.KUBECTL_VERSION}"; echo "Kustomize Version: v5.7.1"`,
      ),
      'KUBECTL_SHA256',
      'sha256',
    );
    put(
      `https://get.helm.sh/helm-v${V.HELM_VERSION}-linux-${arch}.tar.gz`,
      tarball(`helm-${arch}.tgz`, '-czf', {
        [`linux-${arch}/helm`]: `echo "v${V.HELM_VERSION}+g0123456"`,
      }),
      'HELM_SHA256',
      'sha256',
    );
    put(
      `https://github.com/opentofu/opentofu/releases/download/v${V.TOFU_VERSION}/tofu_${V.TOFU_VERSION}_linux_${arch}.tar.gz`,
      tarball(`tofu-${arch}.tgz`, '-czf', {
        tofu: `echo "OpenTofu v${V.TOFU_VERSION}"; echo "on linux_${arch}"`,
      }),
      'TOFU_SHA256',
      'sha256',
    );
    put(
      `https://go.dev/dl/go${V.GO_VERSION}.linux-${arch}.tar.gz`,
      tarball(`go-${arch}.tgz`, '-czf', {
        'go/bin/go': `echo "go version go${V.GO_VERSION} linux/${arch}"`,
        'go/bin/gofmt': 'exit 0',
      }),
      'GO_SHA256',
      'sha256',
    );
    const nd = `node-v${V.NODE_VERSION}-linux-${narch}`;
    put(
      `https://nodejs.org/dist/v${V.NODE_VERSION}/${nd}.tar.xz`,
      tarball(`node-${arch}.txz`, '-cJf', {
        [`${nd}/bin/node`]: `echo "v${V.NODE_VERSION}"`,
        [`${nd}/bin/npm`]: 'echo 10.9.0',
        [`${nd}/bin/npx`]: 'echo 10.9.0',
        [`${nd}/bin/corepack`]: `case "$1" in
  enable) printf '#!/bin/sh\\ncat "$FAKE_STATE/pnpm-version" 2>/dev/null || exit 1\\n' > "$4/pnpm"; chmod 755 "$4/pnpm";;
  install) echo "\${3#pnpm@}" > "$FAKE_STATE/pnpm-version";;
esac`,
      }),
      'NODE_SHA256',
      'sha256',
    );
    put(
      `https://storage.googleapis.com/gvisor/releases/release/${V.RUNSC_VERSION}/${garch}/gvisor.tar.bz2`,
      tarball(`gvisor-${arch}.tbz2`, '-cjf', {
        runsc: `echo "runsc version release-${V.RUNSC_VERSION}"; echo "spec: 1.2.1"`,
        'containerd-shim-runsc-v1': 'exit 0',
      }),
      'RUNSC_SHA512',
      'sha512',
    );
  }
  fs.writeFileSync(
    path.join(dl, urlKey('https://download.docker.com/linux/ubuntu/gpg')),
    'fake docker key\n',
  );
}

/**
 * @typedef {{ root: string, state: string, dir: string, env: Record<string, string> }} Host
 * @param {{ versions?: (text: string) => string }} [opts]
 * @returns {Host}
 */
function makeHost(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-bootstrap-host-'));
  const mock = path.join(dir, 'mock');
  const tools = path.join(dir, 'tools');
  const state = path.join(dir, 'state');
  const root = path.join(dir, 'root');
  for (const d of [
    mock,
    tools,
    path.join(state, 'dpkg'),
    root,
    path.join(dir, 'home'),
    path.join(dir, 'tmp'),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const [name, body] of Object.entries(MOCKS)) writeExec(path.join(mock, name), body);
  for (const t of REAL_TOOLS) fs.symlinkSync(which(t), path.join(tools, t));
  fs.writeFileSync(path.join(state, 'session-groups'), 'dev adm\n');
  fs.writeFileSync(path.join(state, 'gpg-fpr'), V.DOCKER_GPG_FINGERPRINT ?? '');
  const osRelease = path.join(dir, 'os-release');
  fs.writeFileSync(osRelease, 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n');
  let versions = fs.readFileSync(VERSIONS, 'utf8');
  for (const [k, v] of Object.entries(SUMS))
    versions = versions.replace(new RegExp(`^${k}=".*"$`, 'm'), `${k}="${v}"`);
  if (opts.versions) versions = opts.versions(versions);
  const versionsFile = path.join(dir, 'versions.env');
  fs.writeFileSync(versionsFile, versions);
  return {
    dir,
    root,
    state,
    env: {
      PATH: `${mock}:${tools}`,
      HOME: path.join(dir, 'home'),
      TMPDIR: path.join(dir, 'tmp'),
      FAKE_STATE: state,
      FAKE_DL: path.join(FIXTURES, 'dl'),
      BW_BOOTSTRAP_ROOT: root,
      BW_BOOTSTRAP_VERSIONS_FILE: versionsFile,
      BW_BOOTSTRAP_OS_RELEASE: osRelease,
      BW_BOOTSTRAP_REPORT: path.join(dir, 'report.json'),
      BW_BOOTSTRAP_RETRY_DELAY: '1',
    },
  };
}

/**
 * @param {Host} host
 * @param {string[]} [args]
 * @param {Record<string, string>} [extraEnv]
 */
function run(host, args = [], extraEnv = {}) {
  fs.rmSync(path.join(host.state, 'calls'), { force: true });
  const r = spawnSync(BASH, [SCRIPT, ...args], {
    env: { ...host.env, ...extraEnv },
    encoding: 'utf8',
  });
  const callsFile = path.join(host.state, 'calls');
  const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8') : '';
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

/** @param {string} dir @returns {string[]} */
function listTree(dir) {
  return fs.readdirSync(dir, { recursive: true }).map(String);
}

/** @type {string[]} */
const hosts = [];
/** @param {Parameters<typeof makeHost>[0]} [opts] */
function host(opts) {
  const h = makeHost(opts);
  hosts.push(h.dir);
  return h;
}

before(buildFixtures);
after(() => {
  for (const d of [...hosts, FIXTURES]) fs.rmSync(d, { recursive: true, force: true });
});

describe('infra/bootstrap.sh lint', () => {
  it('passes shellcheck', () => {
    const r = spawnSync('shellcheck', ['-x', 'infra/bootstrap.sh'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    assert.equal(r.error, undefined, 'shellcheck must be installed');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it('is bash with strict mode', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(src, /^#!\/usr\/bin\/env bash\n/);
    assert.match(src, /^set -euo pipefail$/m);
    assert.doesNotMatch(src, /docker\.sock:/, 'the script must never bind-mount the docker socket');
  });
});

describe('infra/versions.env pins', () => {
  const required = [
    'DOCKER_VERSION',
    'RUNSC_VERSION',
    'NODE_VERSION',
    'PNPM_VERSION',
    'GO_VERSION',
    'TOFU_VERSION',
    'KUBECTL_VERSION',
    'HELM_VERSION',
    'MKCERT_VERSION',
    'JQ_VERSION',
  ];
  for (const key of required) {
    it(`pins ${key} to an exact version`, () => {
      const value = V[key] ?? '';
      assert.match(value, /^[0-9:]*[0-9]+\.[0-9]+(\.[0-9]+)?[^\s*x]*$/, `${key}="${value}"`);
    });
  }

  it('pins a checksum for every downloaded artifact on both arches', () => {
    for (const tool of [
      'NODE_SHA256',
      'GO_SHA256',
      'TOFU_SHA256',
      'KUBECTL_SHA256',
      'HELM_SHA256',
      'MKCERT_SHA256',
      'JQ_SHA256',
    ]) {
      for (const arch of ['AMD64', 'ARM64'])
        assert.match(V[`${tool}_${arch}`] ?? '', /^[0-9a-f]{64}$/, `${tool}_${arch}`);
    }
    for (const arch of ['AMD64', 'ARM64'])
      assert.match(V[`RUNSC_SHA512_${arch}`] ?? '', /^[0-9a-f]{128}$/);
    assert.match(V.DOCKER_GPG_FINGERPRINT ?? '', /^[0-9A-F]{40}$/);
    assert.match(V.HELLO_WORLD_IMAGE ?? '', /@sha256:[0-9a-f]{64}$/);
  });

  it('agrees with the repo engine pins (Node 22, packageManager pnpm, Go toolchain)', () => {
    const pkg = /** @type {{ packageManager?: string }} */ (
      readJson(path.join(REPO, 'package.json'))
    );
    assert.equal(pkg.packageManager, `pnpm@${V.PNPM_VERSION}`);
    assert.match(V.NODE_VERSION ?? '', /^22\.\d+\.\d+$/);
    const gomod = fs.readFileSync(path.join(REPO, 'apps', 'egress-gateway', 'go.mod'), 'utf8');
    assert.match(
      gomod,
      new RegExp(`^toolchain go${(V.GO_VERSION ?? '').replaceAll('.', '\\.')}$`, 'm'),
    );
  });
});

describe('infra/bootstrap.sh on a fresh Ubuntu 24.04 host', () => {
  it('--dry-run reports the plan, needs no sudo and changes nothing', () => {
    const h = host();
    fs.rmSync(path.join(h.dir, 'mock', 'sudo'));
    const r = run(h, ['--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /dry-run complete: \d+ change\(s\) would be made/);
    assert.match(r.out, /would change: node 22\./);
    assert.deepEqual(listTree(h.root), []);
    assert.doesNotMatch(r.calls, /apt-get install|usermod|curl/);
    assert.equal(fs.existsSync(h.env.BW_BOOTSTRAP_REPORT ?? ''), false);
  });

  it('installs every tool at the pinned version, then a second run changes nothing', () => {
    const h = host();
    const first = run(h);
    assert.equal(first.status, 0, first.out);
    assert.doesNotMatch(first.out, /bootstrap complete: 0 change/);
    for (const tool of [
      'jq',
      'runsc',
      'containerd-shim-runsc-v1',
      'node',
      'npm',
      'corepack',
      'pnpm',
      'go',
      'gofmt',
      'tofu',
      'kubectl',
      'helm',
      'mkcert',
    ]) {
      assert.ok(fs.existsSync(path.join(h.root, 'usr/local/bin', tool)), `${tool} linked`);
    }
    assert.match(
      first.calls,
      /apt-get install -y -q --allow-downgrades --allow-change-held-packages docker-ce=5:29/,
    );
    assert.match(first.calls, /apt-mark hold docker-ce docker-ce-cli containerd\.io/);
    assert.match(first.calls, /usermod -aG docker dev/);
    assert.match(first.calls, /docker run --rm --runtime=runsc --network=none hello-world@sha256:/);
    assert.doesNotMatch(first.calls, /docker run[^\n]*(-v|--volume|--mount)/);
    const daemon = /** @type {unknown} */ (readJson(path.join(h.root, 'etc/docker/daemon.json')));
    assert.deepEqual(daemon, { runtimes: { runsc: { path: '/usr/local/bin/runsc' } } });
    const source = fs.readFileSync(path.join(h.root, 'etc/apt/sources.list.d/docker.list'), 'utf8');
    assert.match(
      source,
      /signed-by=\/etc\/apt\/keyrings\/docker\.asc\] https:\/\/download\.docker\.com\/linux\/ubuntu noble stable/,
    );
    assert.match(first.out, /TOOL\s+EXPECTED\s+ACTUAL\s+STATUS/);
    const report = /** @type {{ ok: boolean, tools: Array<{ status: string }> }} */ (
      readJson(h.env.BW_BOOTSTRAP_REPORT ?? '')
    );
    assert.equal(report.ok, true);
    assert.ok(report.tools.every((t) => t.status === 'OK'));

    const second = run(h);
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /bootstrap complete: 0 change\(s\)/);
    assert.doesNotMatch(second.calls, /curl|apt-get|usermod|systemctl restart|corepack/);

    const check = run(h, ['--check']);
    assert.equal(check.status, 0, check.out);
    assert.match(check.out, /check passed/);
  });
});

describe('infra/bootstrap.sh --check', () => {
  it('exits non-zero and flags the tool when a version drifts', () => {
    const h = host();
    assert.equal(run(h).status, 0);
    const jq = path.join(h.root, 'usr/local/bin/jq');
    fs.rmSync(jq);
    writeExec(jq, 'echo jq-1.7.1');
    const r = run(h, ['--check']);
    assert.notEqual(r.status, 0);
    assert.match(
      r.out,
      new RegExp(`^jq\\s+${V.JQ_VERSION?.replaceAll('.', '\\.')}\\s+1\\.7\\.1\\s+DRIFT$`, 'm'),
    );
    assert.match(r.out, /toolchain drift detected/);
  });

  it('exits non-zero listing missing tools on an empty host', () => {
    const r = run(host(), ['--check']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /^node\s+\S+\s+-\s+MISSING$/m);
  });

  it('fails when any running container has the docker socket mounted', () => {
    const h = host();
    assert.equal(run(h).status, 0);
    fs.writeFileSync(path.join(h.state, 'containers'), 'abc\ndef\n');
    fs.writeFileSync(
      path.join(h.state, 'inspect'),
      '/safe /data\n/leaky /var/run/docker.sock /tmp\n',
    );
    const r = run(h, ['--check']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /^docker\.sock mounts\s+none\s+leaky\s+DRIFT$/m);
  });
});

describe('infra/bootstrap.sh edge cases', () => {
  it('partial prior install: reconciles only what is missing or broken', () => {
    const h = host();
    assert.equal(run(h).status, 0);
    // A half-finished helm install (no completion marker), a dangling node link
    // and a docker package at the wrong version.
    fs.rmSync(path.join(h.root, `usr/local/lib/blackwing/helm/${V.HELM_VERSION}/.complete`));
    fs.rmSync(path.join(h.root, 'usr/local/bin/helm'));
    fs.rmSync(path.join(h.root, 'usr/local/bin/node'));
    fs.writeFileSync(path.join(h.state, 'dpkg', 'containerd.io'), '1.7.0-1');
    const r = run(h);
    assert.equal(r.status, 0, r.out);
    const downloads = r.calls.split('\n').filter((l) => l.startsWith('curl '));
    assert.equal(downloads.length, 1, downloads.join('\n'));
    assert.match(downloads[0] ?? '', /helm-v/);
    assert.match(r.out, /linked .*\/usr\/local\/bin\/node ->/);
    assert.match(r.calls, /apt-get install .*containerd\.io=2\./);
    assert.match(fs.readFileSync(path.join(h.state, 'dpkg', 'containerd.io'), 'utf8'), /^2\./);
  });

  it('no sudo: fails fast and lists the required privileges', () => {
    const h = host();
    fs.rmSync(path.join(h.dir, 'mock', 'sudo'));
    const r = run(h);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /Required privileges/);
    assert.match(r.out, /usermod -aG docker/);
    assert.match(r.out, /sudo is not installed/);
    assert.deepEqual(listTree(h.root), []);
  });

  it('restricted sudo (password needed, no terminal): fails fast with guidance', () => {
    const h = host();
    fs.writeFileSync(path.join(h.state, 'sudo-needs-password'), '');
    const r = run(h);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /Required privileges/);
    assert.match(r.out, /no terminal is attached/);
  });

  it('runs as root without sudo', () => {
    const h = host();
    fs.rmSync(path.join(h.dir, 'mock', 'sudo'));
    const r = run(h, [], { FAKE_UID: '0', FAKE_USER: 'root' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /running as root/);
    assert.doesNotMatch(r.calls, /usermod/);
  });

  it('ARM64: fetches the aarch64/arm64 binaries', () => {
    const h = host();
    const r = run(h, [], { FAKE_ARCH: 'aarch64' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.calls, /gvisor\/releases\/release\/[^/]+\/aarch64\/gvisor\.tar\.bz2/);
    assert.match(r.calls, /node-v[\d.]+-linux-arm64\.tar\.xz/);
    assert.match(r.calls, /go[\d.]+\.linux-arm64\.tar\.gz/);
    assert.match(r.calls, /jq-linux-arm64/);
    assert.doesNotMatch(r.calls, /amd64|x86_64|linux-x64/);
    assert.match(
      fs.readFileSync(path.join(h.root, 'etc/apt/sources.list.d/docker.list'), 'utf8'),
      /arch=arm64/,
    );
  });

  it('unsupported architecture fails fast', () => {
    const r = run(host(), [], { FAKE_ARCH: 's390x' });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /unsupported CPU architecture 's390x'/);
  });

  it('unsupported OS fails fast', () => {
    const h = host();
    fs.writeFileSync(h.env.BW_BOOTSTRAP_OS_RELEASE ?? '', 'ID=debian\nVERSION_ID="12"\n');
    const r = run(h);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /unsupported OS 'debian 12'/);
  });

  it('network flakiness: retries downloads with exponential backoff', () => {
    const h = host();
    fs.writeFileSync(path.join(h.state, 'curl-fail'), '2');
    const r = run(h);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /download attempt 1\/5 failed/);
    assert.match(r.calls, /sleep 1\n(?:.*\n)*?sleep 2\n/);
  });

  it('network down: gives up after the retry budget', () => {
    const h = host();
    fs.writeFileSync(path.join(h.state, 'curl-fail'), '100');
    const r = run(h, [], { BW_BOOTSTRAP_RETRIES: '3' });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /download failed after 3 attempts/);
  });

  it('checksum mismatch: refuses to install the artifact', () => {
    const h = host({
      versions: (t) => t.replace(/^JQ_SHA256_AMD64=".*"$/m, `JQ_SHA256_AMD64="${'0'.repeat(64)}"`),
    });
    const r = run(h);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /checksum mismatch for jq/);
    assert.equal(fs.existsSync(path.join(h.root, 'usr/local/bin/jq')), false);
  });

  it('missing checksum pin: refuses to install an unverified binary', () => {
    const h = host({
      versions: (t) => t.replace(/^MKCERT_SHA256_AMD64=".*"$/m, 'MKCERT_SHA256_AMD64=""'),
    });
    const r = run(h);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /no pinned sha256 checksum for mkcert/);
  });

  it('docker apt key with the wrong fingerprint is rejected', () => {
    const h = host();
    fs.writeFileSync(path.join(h.state, 'gpg-fpr'), 'DEADBEEF'.repeat(5));
    const r = run(h);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /does not match the pinned/);
    assert.doesNotMatch(r.calls, /apt-get install[^\n]*docker-ce=/);
  });

  it('docker group not active in this shell: tells the user to re-login or newgrp', () => {
    const r = run(host());
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /newgrp docker/);
  });

  it('docker group already active: no warning', () => {
    const h = host();
    fs.writeFileSync(path.join(h.state, 'session-groups'), 'dev adm docker\n');
    fs.writeFileSync(path.join(h.state, 'groups-dev'), 'dev adm docker\n');
    const r = run(h);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /newgrp/);
    assert.doesNotMatch(r.calls, /usermod/);
  });

  it('daemon not reachable without the group yet: verification uses sudo docker', () => {
    const h = host();
    fs.writeFileSync(path.join(h.state, 'docker-no-access'), '');
    const r = run(h);
    assert.equal(r.status, 0, r.out);
    assert.match(r.calls, /sudo docker run --rm --runtime=runsc/);
  });

  it('gVisor unsupported kernel: warns with remediation', () => {
    const r = run(host(), [], { FAKE_KERNEL: '4.4.0-210-generic' });
    assert.match(r.out, /kernel 4\.4\.0-210-generic is too old for gVisor/);
    assert.match(r.out, /linux-generic-hwe-24\.04/);
  });

  it('runsc hello-world failure: exits non-zero with remediation', () => {
    const h = host();
    fs.writeFileSync(path.join(h.state, 'runsc-broken'), '');
    const r = run(h);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /^runsc hello-world\s+ok\s+failed\s+DRIFT$/m);
    assert.match(r.out, /remediation: check 'runsc --version'/);
  });

  it('existing daemon.json: keeps other settings and adds runsc', () => {
    const h = host();
    const file = path.join(h.root, 'etc/docker/daemon.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ 'log-driver': 'local', runtimes: { other: { path: '/x' } } }),
    );
    const r = run(h);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(readJson(file), {
      'log-driver': 'local',
      runtimes: { other: { path: '/x' }, runsc: { path: '/usr/local/bin/runsc' } },
    });
    assert.match(r.calls, /systemctl restart docker/);
  });

  it('invalid daemon.json: fails without clobbering it', () => {
    const h = host();
    const file = path.join(h.root, 'etc/docker/daemon.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const r = run(h);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /is not valid JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  });

  it('rejects unknown arguments', () => {
    const r = run(host(), ['--bogus']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /unknown argument: --bogus/);
  });
});
