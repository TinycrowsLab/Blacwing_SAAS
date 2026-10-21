// Offline tests for the INFRA-011 NetworkPolicies (infra/k3s/network-policies). A small
// model of Kubernetes NetworkPolicy semantics (podSelector, namespaceSelector, ports,
// default-deny when selected) evaluates the real manifests against a connectivity
// matrix. The live check against a CNI that enforces them is infra/k3s/network-policies/verify.sh.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseAllDocuments } from 'yaml';

import { REPO_ROOT } from './test-fixtures.mjs';

/** @typedef {Record<string, string>} Labels */
/** @typedef {{ matchLabels?: Labels, matchExpressions?: { key: string, operator: string, values: string[] }[] }} Sel */
/** @typedef {{ podSelector?: Sel, namespaceSelector?: Sel, ipBlock?: unknown }} Peer */
/** @typedef {{ ports?: { port: number, protocol: string }[], to?: Peer[], from?: Peer[], action?: string, destination?: { nets: string[] } }} Rule */
/** @typedef {{ kind: string, metadata: { name: string, namespace: string }, spec: { policyTypes: string[], podSelector: Sel, egress?: Rule[], ingress?: Rule[], order?: number } }} Doc */
/** @typedef {{ ns: string, labels: Labels }} Pod */

const DIR = path.join(REPO_ROOT, 'infra/k3s/network-policies');
/** @param {string} f */
const read = (f) => readFileSync(path.join(DIR, f), 'utf8');
/** @param {string} f @returns {Doc[]} */
const load = (f) =>
  parseAllDocuments(read(f)).map((d) => {
    /** @type {unknown} */
    const js = d.toJS();
    return /** @type {Doc} */ (js);
  });
const FILES = [
  '00-default-deny.yaml',
  '10-bw-system-apps.yaml',
  '20-run-broker.yaml',
  '30-sandbox.yaml',
];
const ALL = FILES.flatMap((f) => load(f));

/** @param {string} ns @param {Labels} labels @returns {Pod} */
const pod = (ns, labels) => ({ ns, labels: { ...labels, 'kubernetes.io/metadata.name': ns } });
/** @param {string} ns @returns {Labels} */
const nsLabels = (ns) => ({ 'kubernetes.io/metadata.name': ns });

/** @param {Sel | undefined} sel @param {Labels} labels @returns {boolean} */
function selMatch(sel, labels) {
  if (!sel) return true;
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) if (labels[k] !== v) return false;
  for (const e of sel.matchExpressions ?? []) {
    assert.equal(e.operator, 'In');
    if (!e.values.includes(labels[e.key] ?? '')) return false;
  }
  return true;
}
/** @param {Pod} p @returns {Labels} */
const podLabels = (p) =>
  Object.fromEntries(Object.entries(p.labels).filter(([k]) => k !== 'kubernetes.io/metadata.name'));
/** @param {Peer} peer @param {string} policyNs @param {Pod} p @returns {boolean} */
function peerMatch(peer, policyNs, p) {
  assert.equal(peer.ipBlock, undefined, 'no ipBlock allowed in these policies');
  const nsOk = peer.namespaceSelector
    ? selMatch(peer.namespaceSelector, nsLabels(p.ns))
    : p.ns === policyNs;
  return nsOk && selMatch(peer.podSelector, podLabels(p));
}
/** @param {Rule} rule @param {number} port @param {string} proto @returns {boolean} */
function portOk(rule, port, proto) {
  if (rule.ports === undefined) return true;
  return rule.ports.some((x) => x.port === port && x.protocol === proto);
}
/**
 * direction 'Egress' judges `self` talking to `other`; 'Ingress' judges `self` receiving from `other`.
 * @param {Doc[]} policies @param {'Egress' | 'Ingress'} dir @param {Pod} self @param {Pod} other
 * @param {number} port @param {string} proto @returns {boolean}
 */
function allowed(policies, dir, self, other, port, proto) {
  const selecting = policies.filter(
    (p) =>
      p.kind === 'NetworkPolicy' &&
      p.metadata.namespace === self.ns &&
      p.spec.policyTypes.includes(dir) &&
      selMatch(p.spec.podSelector, podLabels(self)),
  );
  if (selecting.length === 0) return true;
  const key = dir === 'Egress' ? 'egress' : 'ingress';
  const peerKey = dir === 'Egress' ? 'to' : 'from';
  return selecting.some((p) =>
    (p.spec[key] ?? []).some(
      (r) =>
        (r[peerKey] ?? []).some((peer) => peerMatch(peer, p.metadata.namespace, other)) &&
        portOk(r, port, proto),
    ),
  );
}
/**
 * Pod-to-pod connection is allowed only if egress of the source AND ingress of the target allow it.
 * @param {Doc[]} policies @param {Pod} src @param {Pod} dst @param {number} port @param {string} [proto]
 * @returns {boolean}
 */
const connect = (policies, src, dst, port, proto = 'TCP') =>
  allowed(policies, 'Egress', src, dst, port, proto) &&
  allowed(policies, 'Ingress', dst, src, port, proto);
/**
 * Anything that is not a pod we model (internet, IMDS, IPv6): only egress policy applies; no ipBlock allows exist.
 * @param {Doc[]} policies @param {Pod} src @returns {boolean}
 */
const connectExternal = (policies, src) => {
  const own = policies.filter(
    (p) =>
      p.kind === 'NetworkPolicy' &&
      p.metadata.namespace === src.ns &&
      p.spec.policyTypes.includes('Egress') &&
      selMatch(p.spec.podSelector, podLabels(src)),
  );
  if (own.length === 0) return true;
  return own.some((p) =>
    (p.spec.egress ?? []).some((r) => (r.to ?? []).some((x) => x.ipBlock !== undefined)),
  );
};

/** @param {string} run */
const sandbox = (run) =>
  pod('sandbox', { 'blackwing.io/component': 'sandbox', 'blackwing.io/run': run });
/** @param {string} name */
const svc = (name) => pod('bw-system', { 'app.kubernetes.io/name': name });
const dns = pod('kube-system', { 'k8s-app': 'kube-dns' });
const outside = pod('bw-dev-outside', { app: 'outside' });

describe('sandbox three-destination rule', () => {
  const sb = sandbox('run-a');
  it('reaches egress-gateway, model-gateway and the broker', () => {
    assert.ok(connect(ALL, sb, svc('egress-gateway'), 13128));
    assert.ok(connect(ALL, sb, svc('model-gateway'), 13500));
    assert.ok(connect(ALL, sb, svc('api'), 13400));
    assert.ok(connect(ALL, sb, svc('run-broker'), 13400));
  });
  it('reaches kube-dns on 53 only', () => {
    assert.ok(connect(ALL, sb, dns, 53, 'UDP'));
    assert.ok(connect(ALL, sb, dns, 53, 'TCP'));
    assert.ok(!connect(ALL, sb, dns, 443));
  });
  it('cannot reach the internet, cloud metadata (v4/v6) or other IPv6 targets', () => {
    assert.equal(connectExternal(ALL, sb), false);
    assert.ok(!ALL.some((d) => JSON.stringify(d).includes('ipBlock')));
  });
  it('cannot reach other namespaces or platform data services', () => {
    assert.ok(!connect(ALL, sb, outside, 80));
    for (const [n, p] of [
      ['postgres', 5432],
      ['valkey', 6379],
      ['temporal', 7233],
      ['openbao', 8200],
      ['keycloak', 8080],
    ]) {
      assert.ok(!connect(ALL, sb, svc(n), p), n);
    }
  });
  it('cannot use the wrong port on an allowed destination', () => {
    assert.ok(!connect(ALL, sb, svc('egress-gateway'), 13129));
    assert.ok(!connect(ALL, sb, svc('model-gateway'), 13128));
  });
});

describe('cross-run isolation', () => {
  /** @param {string} id @returns {Doc} */
  const run = (id) => {
    /** @type {unknown} */
    const parsed = JSON.parse(
      JSON.stringify(load('run-isolation.template.yaml')[0]).replaceAll('__RUN_ID__', id),
    );
    return /** @type {Doc} */ (parsed);
  };
  it('without a per-run policy, sandbox pods of different runs cannot connect', () => {
    assert.ok(!connect(ALL, sandbox('run-a'), sandbox('run-b'), 8080));
    assert.ok(!connect(ALL, sandbox('run-b'), sandbox('run-a'), 8080));
  });
  it('with per-run policies a run reaches only its own pods', () => {
    const pols = [...ALL, run('run-a'), run('run-b')];
    assert.ok(connect(pols, sandbox('run-a'), sandbox('run-a'), 8080));
    assert.ok(!connect(pols, sandbox('run-a'), sandbox('run-b'), 8080));
    assert.ok(!connect(pols, sandbox('run-b'), sandbox('run-a'), 8080));
  });
});

describe('Run Broker ingress', () => {
  it('accepts sandbox pods and rejects non-sandbox pods and other namespaces', () => {
    assert.ok(connect(ALL, sandbox('run-a'), svc('run-broker'), 13400));
    assert.ok(!connect(ALL, outside, svc('run-broker'), 13400));
    assert.ok(!connect(ALL, outside, svc('api'), 13400));
    assert.ok(
      !connect(ALL, pod('sandbox', { 'app.kubernetes.io/name': 'intruder' }), svc('api'), 13400),
    );
    assert.ok(!connect(ALL, svc('web'), svc('run-broker'), 13400));
  });
});

describe('fail closed', () => {
  it('a mislabeled sandbox pod gets no egress at all', () => {
    const bad = pod('sandbox', {
      'blackwing.io/component': 'sandbxo',
      'blackwing.io/run': 'run-a',
    });
    for (const [n, p] of [
      ['egress-gateway', 13128],
      ['model-gateway', 13500],
      ['run-broker', 13400],
    ]) {
      assert.ok(!connect(ALL, bad, svc(n), p), n);
    }
    assert.ok(!connect(ALL, bad, dns, 53, 'UDP'));
    assert.equal(connectExternal(ALL, bad), false);
  });
  it('an unlabeled platform pod in bw-system is denied everything', () => {
    const stray = pod('bw-system', { app: 'stray' });
    assert.ok(!connect(ALL, stray, svc('postgres'), 5432));
    assert.ok(!connect(ALL, svc('api'), stray, 80));
    assert.equal(connectExternal(ALL, stray), false);
  });
  it('removing default-deny makes the matrix detect open egress (regression guard)', () => {
    const without = ALL.filter((d) => d.metadata.name !== 'default-deny-all');
    // sandbox-egress still selects labelled pods, but a mislabeled pod is now open
    const bad = pod('sandbox', { 'blackwing.io/component': 'sandbxo' });
    assert.equal(connectExternal(without, bad), true);
    assert.ok(connect(without, bad, outside, 80));
  });
  it('removing the sandbox-egress allow is detected as lost connectivity', () => {
    const without = ALL.filter((d) => d.metadata.name !== 'sandbox-egress');
    assert.ok(!connect(without, sandbox('run-a'), svc('egress-gateway'), 13128));
  });
  it('removing one per-app allow breaks exactly that flow', () => {
    const without = ALL.filter((d) => d.metadata.name !== 'allow-postgres');
    assert.ok(connect(ALL, svc('api'), svc('postgres'), 5432));
    assert.ok(!connect(without, svc('api'), svc('postgres'), 5432));
  });
});

describe('platform apps', () => {
  it('default-deny exists in every Blackwing namespace for ingress and egress', () => {
    for (const ns of ['bw-system', 'sandbox']) {
      const d = ALL.find(
        (x) => x.metadata.name === 'default-deny-all' && x.metadata.namespace === ns,
      );
      assert.ok(d, ns);
      assert.deepEqual(d.spec.policyTypes, ['Ingress', 'Egress']);
      assert.deepEqual(d.spec.podSelector, {});
    }
  });
  it('api, worker and web reach what they need and not each other arbitrarily', () => {
    assert.ok(connect(ALL, svc('api'), svc('postgres'), 5432));
    assert.ok(connect(ALL, svc('api'), svc('valkey'), 6379));
    assert.ok(connect(ALL, svc('api'), svc('temporal'), 7233));
    assert.ok(connect(ALL, svc('api'), svc('keycloak'), 8080));
    assert.ok(connect(ALL, svc('api'), svc('openbao'), 8200));
    assert.ok(connect(ALL, svc('worker'), svc('temporal'), 7233));
    assert.ok(connect(ALL, svc('worker'), svc('postgres'), 5432));
    assert.ok(connect(ALL, svc('api'), dns, 53, 'UDP'));
    assert.ok(
      connect(ALL, pod('kube-system', { 'app.kubernetes.io/name': 'traefik' }), svc('web'), 3000),
    );
    assert.ok(!connect(ALL, svc('web'), svc('postgres'), 5432));
    assert.ok(!connect(ALL, svc('worker'), svc('openbao'), 8200));
    assert.ok(
      !connect(
        ALL,
        pod('kube-system', { 'app.kubernetes.io/name': 'traefik' }),
        svc('postgres'),
        5432,
      ),
    );
  });
  it('DNS from bw-system goes to kube-dns only', () => {
    assert.ok(!connect(ALL, svc('api'), outside, 53, 'UDP'));
  });
});

describe('manifests and scripts', () => {
  it('apply.sh applies default-deny before any allow', () => {
    const m = /for f in ([^;]+); do/.exec(read('apply.sh'));
    assert.ok(m?.[1]);
    const order = m[1].trim().split(/\s+/);
    assert.equal(order[0], '00-default-deny.yaml');
    assert.deepEqual(order, FILES);
  });
  it('shell scripts parse', () => {
    for (const f of ['apply.sh', 'verify.sh', 'calico/install.sh']) {
      const r = spawnSync('bash', ['-n', path.join(DIR, f)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  });
  it('apply.sh --render-run substitutes a valid id and rejects injection', () => {
    const ok = spawnSync('bash', [path.join(DIR, 'apply.sh'), '--render-run', 'run-abc1'], {
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /blackwing\.io\/run: run-abc1/);
    assert.doesNotMatch(ok.stdout, /__RUN_ID__/);
    const bad = spawnSync('bash', [path.join(DIR, 'apply.sh'), '--render-run', 'a/../b;x'], {
      encoding: 'utf8',
    });
    assert.equal(bad.status, 2);
  });
  it('Calico is pinned and the global policy denies metadata, link-local and IPv6 before allows', () => {
    const v = read('calico/versions.env');
    assert.match(v, /CALICO_VERSION="v\d+\.\d+\.\d+"/);
    assert.match(v, /calico\/v3\.\d+\.\d+\/manifests/);
    const g = load('calico/global-deny-sandbox-metadata.yaml')[0];
    assert.equal(g.kind, 'GlobalNetworkPolicy');
    assert.ok(g.spec.order < 1000);
    assert.equal(g.spec.egress[0].action, 'Deny');
    const nets = g.spec.egress[0].destination.nets;
    for (const n of ['169.254.169.254/32', '169.254.0.0/16', 'fd00:ec2::254/128', '::/0'])
      assert.ok(nets.includes(n), n);
  });
  it('passes kubeconform when available', () => {
    const which = spawnSync('which', ['kubeconform'], { encoding: 'utf8' });
    if (which.status !== 0) return;
    const r = spawnSync(
      'kubeconform',
      [
        '-strict',
        '-summary',
        ...FILES.map((f) => path.join(DIR, f)),
        path.join(DIR, 'run-isolation.template.yaml'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});
