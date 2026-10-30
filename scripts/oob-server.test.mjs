// Self-tests for the out-of-band listener chart (INFRA-010): infra/helm/bw-oob, the pinned
// interactsh-server image and the isolation from the sandbox network. Everything is rendered offline with
// `helm template`; nothing talks to a cluster, Route53, Let's Encrypt or a public address. The live
// half (a real DNS/HTTP/HTTPS interaction against the delegated zone, from a dedicated node) is #910;
// see docs/runbooks/oob-server.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAllDocuments } from 'yaml';

import { kubeconformSkipReason } from './test-fixtures.mjs';

/** @typedef {Record<string, unknown>} Obj */

const KUBECONFORM_SKIP = kubeconformSkipReason();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHART = path.join(REPO, 'infra', 'helm', 'bw-oob');
const COMPOSE = path.join(REPO, 'infra', 'compose', 'docker-compose.dev.yml');
const SANDBOX_EGRESS = path.join(REPO, 'infra', 'k3s', 'network-policies', '30-sandbox.yaml');
const DIGEST = 'sha256:ffde50de2cdc9113b9bb024d9dbe63a7a4826de213be1cc63a7ffd5fd3b14481';
const BASE = [
  '--set',
  'domain=bw.example',
  '--set',
  'publicIP=203.0.113.10',
  '--set',
  'existingSecret=bw-oob-token',
];

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
    cur = /** @type {Record<string, unknown>} */ (cur)[key];
  }
  return cur;
}

/** @param {unknown} v @returns {string[]} */
const strs = (v) => /** @type {string[]} */ (v);
/** @param {unknown} v @returns {Obj[]} */
const objs = (v) => /** @type {Obj[]} */ (v);

/**
 * @param {string[]} extra helm --set style arguments
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function helm(extra = []) {
  const r = spawnSync('helm', ['template', 'bw-oob', CHART, '-n', 'bw-oob', ...BASE, ...extra], {
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * @param {string[]} extra
 * @returns {Obj[]} the rendered objects
 */
function render(extra = []) {
  const r = helm(extra);
  assert.equal(r.status, 0, r.stderr);
  return parseAllDocuments(r.stdout)
    .map((d) => {
      /** @type {unknown} */
      const js = d.toJS();
      return js;
    })
    .filter((o) => isObj(o));
}

/**
 * @param {Obj[]} objects
 * @param {string} kind
 * @returns {Obj}
 */
function one(objects, kind) {
  const found = objects.filter((o) => o.kind === kind);
  assert.equal(found.length, 1, `expected exactly one ${kind}`);
  const [only] = found;
  assert.ok(only, `expected exactly one ${kind}`);
  return only;
}

/**
 * @param {Obj[]} [objects]
 * @returns {Obj} the single interactsh container of the Deployment
 */
function container(objects = render()) {
  return /** @type {Obj} */ (
    at(one(objects, 'Deployment'), 'spec.template.spec.containers.0') ?? {}
  );
}

describe('image pin', () => {
  it('pins the interactsh-server image by digest and matches the dev compose pin', () => {
    const image = container().image;
    assert.equal(image, `projectdiscovery/interactsh-server:v1.2.4@${DIGEST}`);
    const compose = fs.readFileSync(COMPOSE, 'utf8');
    assert.ok(compose.includes(image), 'compose and the chart must pin the same image digest');
  });

  it('refuses to render without an image digest', () => {
    const r = helm(['--set', 'image.digest=']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /image\.digest is required/);
  });
});

describe('container hardening', () => {
  it('runs non-root with a read-only root filesystem, no capabilities and no escalation', () => {
    const objects = render();
    const pod = at(one(objects, 'Deployment'), 'spec.template.spec');
    assert.equal(at(pod, 'securityContext.runAsNonRoot'), true);
    assert.equal(at(pod, 'securityContext.runAsUser'), 65532);
    assert.equal(at(pod, 'securityContext.seccompProfile.type'), 'RuntimeDefault');
    assert.equal(at(pod, 'automountServiceAccountToken'), false);
    const sc = container(objects).securityContext;
    assert.equal(at(sc, 'readOnlyRootFilesystem'), true);
    assert.equal(at(sc, 'allowPrivilegeEscalation'), false);
    assert.equal(at(sc, 'runAsNonRoot'), true);
    assert.deepEqual(at(sc, 'capabilities'), { drop: ['ALL'] });
  });

  it('keeps the control token in a Secret reference, never as a literal value', () => {
    const env = objs(container().env);
    const token = env.find((e) => e.name === 'INTERACTSH_TOKEN');
    assert.deepEqual(token, {
      name: 'INTERACTSH_TOKEN',
      valueFrom: { secretKeyRef: { name: 'bw-oob-token', key: 'token' } },
    });
    const args = strs(container().args);
    assert.equal(
      args[args.indexOf('-token') + 1],
      '$(INTERACTSH_TOKEN)',
      'the flag reads the env var',
    );
  });

  it('gives the server a writable /tmp and a read-only config and certificate mount', () => {
    const mounts = objs(container().volumeMounts);
    assert.deepEqual(mounts.map((m) => String(m.mountPath)).sort(), ['/config', '/tls', '/tmp']);
    assert.equal(mounts.find((m) => m.mountPath === '/tls')?.readOnly, true);
    assert.equal(mounts.find((m) => m.mountPath === '/config')?.readOnly, true);
  });

  it('sets resource limits and both probes on the HTTP listener', () => {
    const c = container();
    assert.ok(at(c, 'resources.limits.memory'), 'memory limit');
    assert.ok(at(c, 'resources.limits.cpu'), 'cpu limit');
    assert.equal(at(c, 'readinessProbe.httpGet.path'), '/');
    assert.equal(at(c, 'livenessProbe.httpGet.path'), '/');
  });
});

describe('listeners and server arguments', () => {
  it('serves the delegated zone with the public address, custom TLS and no ACME', () => {
    const args = strs(container().args);
    assert.deepEqual(args.slice(0, 4), ['-domain', 'oob.bw.example', '-ip', '203.0.113.10']);
    assert.ok(args.includes('-cert') && args.includes('-privkey'), 'custom TLS certificate');
    assert.ok(!args.includes('-skip-acme'), 'skip-acme would disable TLS');
    assert.ok(args.includes('-disable-update-check'), 'no self-update at runtime');
  });

  it('maps DNS, HTTP, HTTPS and SMTP to their public ports, all unprivileged inside the container', () => {
    const ports = objs(container().ports);
    /** @param {string} name */
    const host = (name) =>
      ports.filter((p) => p.name === name).map((p) => [p.hostPort, p.containerPort, p.protocol]);
    assert.deepEqual(host('dns-udp'), [[53, 5353, 'UDP']]);
    assert.deepEqual(host('dns-tcp'), [[53, 5353, 'TCP']]);
    assert.deepEqual(host('http'), [[80, 8080, 'TCP']]);
    assert.deepEqual(host('https'), [[443, 8443, 'TCP']]);
    assert.deepEqual(host('smtp'), [[25, 2525, 'TCP']]);
    for (const p of ports)
      assert.ok(Number(p.containerPort) >= 1024, `${String(p.name)} binds a privileged port`);
  });

  it('exposes only the enabled listeners on the host', () => {
    const off = ['--set', 'listeners.smtp=false', '--set', 'listeners.https=false'];
    const names = objs(container(render(off)).ports).map((p) => p.name);
    assert.ok(!names.includes('smtp') && !names.includes('https'));
    assert.ok(names.includes('dns-udp') && names.includes('http'));
    const allowed = objs(at(one(render(off), 'NetworkPolicy'), 'spec.ingress.0.ports'));
    assert.ok(!allowed.some((p) => p.port === 2525 || p.port === 8443));
  });

  it('runs one replica that is recreated, never rolled, because the host ports and the store are single-copy', () => {
    const dep = one(render(), 'Deployment');
    assert.equal(at(dep, 'spec.replicas'), 1);
    assert.deepEqual(at(dep, 'spec.strategy'), { type: 'Recreate' });
  });

  it('pins placement to a dedicated node, away from the Traefik host ports', () => {
    const spec = at(one(render(), 'Deployment'), 'spec.template.spec');
    assert.deepEqual(at(spec, 'nodeSelector'), { 'blackwing.io/oob': 'true' });
    assert.ok(objs(at(spec, 'tolerations')).some((t) => t.key === 'blackwing.io/oob'));
  });
});

describe('certificate', () => {
  it('requests a wildcard and apex certificate for the delegated zone from the ClusterIssuer', () => {
    const cert = one(render(), 'Certificate');
    assert.deepEqual(at(cert, 'spec.dnsNames'), ['*.oob.bw.example', 'oob.bw.example']);
    assert.equal(at(cert, 'spec.issuerRef.kind'), 'ClusterIssuer');
    assert.equal(at(cert, 'spec.issuerRef.name'), 'letsencrypt-staging');
    assert.equal(at(cert, 'spec.secretName'), 'bw-oob-tls');
  });

  it('uses the production issuer only when it is set explicitly', () => {
    const cert = one(render(['--set', 'tls.issuer=letsencrypt-prod']), 'Certificate');
    assert.equal(at(cert, 'spec.issuerRef.name'), 'letsencrypt-prod');
  });
});

describe('network isolation', () => {
  it('excepts the cluster pod and service CIDRs from the public listener rule', () => {
    const np = one(render(), 'NetworkPolicy');
    assert.deepEqual(at(np, 'spec.ingress.0.from.0.ipBlock'), {
      cidr: '0.0.0.0/0',
      except: ['10.42.0.0/16', '10.43.0.0/16'],
    });
  });

  it('lets only the control-plane namespace reach the poll API inside the cluster', () => {
    const np = one(render(), 'NetworkPolicy');
    const cp = at(np, 'spec.ingress.1');
    assert.deepEqual(at(cp, 'from.0.namespaceSelector.matchExpressions.0.values'), ['bw-system']);
    assert.deepEqual(at(cp, 'ports'), [{ protocol: 'TCP', port: 8080 }]);
  });

  it('denies all egress: the server needs no outbound connection', () => {
    const np = one(render(), 'NetworkPolicy');
    assert.deepEqual(at(np, 'spec.policyTypes'), ['Ingress', 'Egress']);
    assert.deepEqual(at(np, 'spec.egress'), []);
  });

  it('gives the control plane a ClusterIP Service only, never a LoadBalancer or host network', () => {
    const svc = one(render(), 'Service');
    assert.equal(at(svc, 'spec.type'), 'ClusterIP');
    const pod = at(one(render(), 'Deployment'), 'spec.template.spec');
    assert.notEqual(at(pod, 'hostNetwork'), true);
  });

  it('keeps the sandbox egress allowlist free of the OOB listener and of any IP range', () => {
    const text = fs.readFileSync(SANDBOX_EGRESS, 'utf8');
    assert.ok(!text.includes('bw-oob'), 'sandboxes must not be allowed to reach the OOB listener');
    const policies = parseAllDocuments(text).map((d) => {
      /** @type {unknown} */
      const js = d.toJS();
      return js;
    });
    const rules = JSON.stringify(policies.map((p) => at(p, 'spec.egress')));
    assert.ok(
      !rules.includes('ipBlock'),
      'sandbox egress has no IP ranges, so the Internet is unreachable',
    );
  });
});

describe('fail-closed validation', () => {
  it('refuses to render without a domain', () => {
    const r = helm(['--set', 'domain=']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /domain is required/);
  });

  it('refuses to render without a public address', () => {
    const r = helm(['--set', 'publicIP=']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /publicIP is required/);
  });

  it('refuses private, loopback, link-local, CGNAT and multicast addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.10.1',
      '172.20.0.1',
      '192.168.1.5',
      '100.64.0.9',
      '224.0.0.1',
      '0.0.0.0',
    ]) {
      const r = helm(['--set', `publicIP=${ip}`]);
      assert.notEqual(r.status, 0, `${ip} must be rejected`);
      assert.match(r.stderr, /private, loopback, link-local or multicast/, ip);
    }
  });

  it('refuses values that are not IPv4 addresses', () => {
    for (const ip of ['203.0.113', '999.1.1.1', '2001:db8::1', 'example.com']) {
      const r = helm(['--set', `publicIP=${ip}`]);
      assert.notEqual(r.status, 0, `${ip} must be rejected`);
      assert.match(r.stderr, /is not an IPv4 address|private, loopback/, ip);
    }
  });

  it('refuses a domain that is not a DNS name', () => {
    const r = helm(['--set', 'domain=bw example']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a valid DNS name/);
  });

  it('refuses an OOB label that contains a dot (it would sit inside another delegated subtree)', () => {
    const r = helm(['--set', 'oobLabel=x.oob']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /one lower-case DNS label/);
  });

  it('refuses to render without the token Secret reference', () => {
    const r = helm(['--set', 'existingSecret=']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /existingSecret is required/);
  });

  it('refuses to render without a dedicated node selector', () => {
    const r = helm(['--set', 'placement.nodeSelector=null']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /placement\.nodeSelector is required/);
  });
});

describe('kubeconform', () => {
  it(
    'validates every rendered object against the Kubernetes and cert-manager schemas',
    { skip: KUBECONFORM_SKIP },
    () => {
      const rendered = helm();
      assert.equal(rendered.status, 0, rendered.stderr);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-oob-'));
      try {
        const file = path.join(dir, 'bw-oob.yaml');
        fs.writeFileSync(file, rendered.stdout);
        const r = spawnSync(
          'kubeconform',
          ['-strict', '-summary', '-ignore-missing-schemas', '-schema-location', 'default', file],
          { encoding: 'utf8' },
        );
        assert.equal(r.status, 0, r.stdout + r.stderr);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
