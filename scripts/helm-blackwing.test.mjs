// Self-tests for the Blackwing umbrella chart (#44) and its image hand-off (scripts/helm-images.mjs).
// Everything is rendered offline with `helm template`; nothing talks to a cluster or a registry. The
// fixtures use synthetic digests. A real install on a kind/k3s cluster needs the published images and
// is the integration half (see infra/helm/blackwing/README.md).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAllDocuments } from 'yaml';

import { buildImageValues, CHART_APPS } from './helm-images.mjs';
import { kubeconformSkipReason } from './test-fixtures.mjs';

const KUBECONFORM_SKIP = kubeconformSkipReason();
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS, '..');
const CHART = path.join(REPO, 'infra', 'helm', 'blackwing');
const TEMPLATES = path.join(CHART, 'templates');
const IMAGES_SCRIPT = path.join(SCRIPTS, 'helm-images.mjs');

const TMP = mkdtempSync(path.join(os.tmpdir(), 'bw-helm-'));
after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const DIGEST = (/** @type {string} */ c) => `sha256:${c.repeat(64)}`;
const REGISTRY = 'ghcr.io/tinycrowslab';
/** Synthetic CI-007 hand-off: every service (including the two the chart does not deploy). */
const IMAGES = Object.fromEntries(
  [
    'api',
    'web',
    'worker',
    'agent-runtime',
    'model-gateway',
    'egress-gateway',
    'session-manager',
    'sandbox-controller',
    'cli',
  ].map((s, i) => [s, `${REGISTRY}/bw-${s}@${DIGEST(String.fromCharCode(97 + (i % 6)))}`]),
);
const SANDBOX_REF = `${REGISTRY}/bw-sandbox@${DIGEST('f')}`;

/**
 * Writes a hand-off fixture and renders the image values file with the script under test.
 * @param {string} name fixture directory name
 * @param {Record<string, unknown>} images images.json content
 * @param {string} sandboxDigest IMAGE_DIGEST content
 * @returns {{ status: number | null, out: string, stderr: string }}
 */
function renderHandOff(name, images, sandboxDigest) {
  const dir = mkdtempSync(path.join(TMP, `${name}-`));
  const imagesFile = path.join(dir, 'images.json');
  const digestFile = path.join(dir, 'IMAGE_DIGEST');
  const out = path.join(dir, 'values-images.yaml');
  writeFileSync(imagesFile, JSON.stringify(images));
  writeFileSync(digestFile, sandboxDigest);
  const r = spawnSync(
    process.execPath,
    [IMAGES_SCRIPT, '--images-json', imagesFile, '--out', out, '--sandbox-digest', digestFile],
    { encoding: 'utf8' },
  );
  return { status: r.status, out, stderr: r.stderr };
}

/** The generated hand-off used by the chart tests (valid digests from the synthetic IMAGES). */
const GOOD = renderHandOff('good', IMAGES, `${SANDBOX_REF}\n`);
assert.equal(GOOD.status, 0, GOOD.stderr);

/** @typedef {Record<string, unknown>} Doc */

/** @param {unknown} o @param {string} p @returns {unknown} */
function at(o, p) {
  let cur = o;
  for (const key of p.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = /** @type {Record<string, unknown>} */ (cur)[key];
  }
  return cur;
}

/**
 * Runs helm template for one environment, with the generated hand-off merged in.
 * @param {string} env dev | staging | prod
 * @param {string[]} [extra] extra helm arguments
 * @param {boolean} [withHandOff]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function helmTemplate(env, extra = [], withHandOff = true) {
  const args = [
    'template',
    'blackwing',
    CHART,
    '-n',
    'bw-system',
    '-f',
    path.join(CHART, `values-${env}.yaml`),
  ];
  if (withHandOff) args.push('-f', GOOD.out);
  const r = spawnSync('helm', [...args, ...extra], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Renders one environment and returns the parsed objects.
 * @param {string} env
 * @param {string[]} [extra]
 * @returns {Doc[]}
 */
function render(env, extra = []) {
  const r = helmTemplate(env, extra);
  assert.equal(r.status, 0, r.stderr);
  return parseAllDocuments(r.stdout)
    .map((d) => /** @type {unknown} */ (d.toJS()) ?? null)
    .filter((d) => d !== null && typeof d === 'object')
    .map((d) => /** @type {Doc} */ (d));
}

/** @param {Doc[]} docs @param {string} kind @returns {Doc[]} */
const ofKind = (docs, kind) => docs.filter((d) => d.kind === kind);
/** @param {Doc[]} docs @param {string} kind @param {string} name @returns {Doc} */
function one(docs, kind, name) {
  const found = ofKind(docs, kind).find((d) => at(d, 'metadata.name') === name);
  assert.ok(found, `${kind}/${name} is rendered`);
  return found;
}
/** @param {unknown} o @param {string} p @returns {Record<string, unknown>} */
function recordAt(o, p) {
  return /** @type {Record<string, unknown>} */ (at(o, p) ?? {});
}
/** @param {Doc} d @returns {Record<string, string>} */
const nodeSelectorOf = (d) =>
  /** @type {Record<string, string>} */ (at(d, 'spec.template.spec.nodeSelector') ?? {});
/** @param {Doc} d @returns {Doc[]} */
const containers = (d) => /** @type {Doc[]} */ (at(d, 'spec.template.spec.containers') ?? []);

describe('image hand-off (scripts/helm-images.mjs)', () => {
  it('writes global.images for every chart app and the sandbox digest from IMAGE_DIGEST', () => {
    const values =
      /** @type {{ global: { images: Record<string, string>, sandbox: { imageRef: string } } }} */ (
        buildImageValues(IMAGES, `${SANDBOX_REF}\n`)
      );
    assert.deepEqual(Object.keys(values.global.images).sort(), [...CHART_APPS].sort());
    for (const app of CHART_APPS) assert.equal(values.global.images[app], IMAGES[app]);
    assert.equal(values.global.sandbox.imageRef, SANDBOX_REF, 'surrounding whitespace is trimmed');
  });

  it('fails closed when an app is missing from images.json', () => {
    /** @type {Record<string, string>} */
    const rest = { ...IMAGES };
    delete rest.api;
    const r = renderHandOff('missing-api', rest, SANDBOX_REF);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no entry for api/);
  });

  it('refuses a tag, a foreign registry, or another image name, and never falls back to a tag', () => {
    for (const bad of [
      `${REGISTRY}/bw-api:1.4.2`,
      `docker.io/tinycrowslab/bw-api@${DIGEST('a')}`,
      `${REGISTRY}/bw-web@${DIGEST('a')}`,
      `${REGISTRY}/bw-api@sha256:${'a'.repeat(63)}`,
      `${REGISTRY}/bw-api@sha256:${'A'.repeat(64)}`,
    ]) {
      const r = renderHandOff('bad-api', { ...IMAGES, api: bad }, SANDBOX_REF);
      assert.notEqual(r.status, 0, `${bad} must be refused`);
      assert.match(r.stderr, /api is not a digest-pinned/);
    }
  });

  it('fails when IMAGE_DIGEST is empty, a tag, or names another image', () => {
    assert.match(renderHandOff('empty-digest', IMAGES, '\n').stderr, /empty file/);
    assert.notEqual(renderHandOff('tag-digest', IMAGES, `${REGISTRY}/bw-sandbox:latest`).status, 0);
    const wrongImage = renderHandOff(
      'wrong-sbx',
      IMAGES,
      `${REGISTRY}/bw-sandbox-controller@${DIGEST('f')}`,
    );
    assert.notEqual(wrongImage.status, 0);
    assert.match(wrongImage.stderr, /bw-sandbox reference/);
  });

  it('fails when IMAGE_DIGEST is absent (IMAGE-012 has not surfaced it yet)', () => {
    const r = spawnSync(
      process.execPath,
      [
        IMAGES_SCRIPT,
        '--images-json',
        path.join(TMP, 'good', 'images.json'),
        '--out',
        path.join(TMP, 'x.yaml'),
        '--sandbox-digest',
        path.join(TMP, 'no-such-file'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ENOENT/);
  });

  it('rejects a non-object images.json and a missing argument', () => {
    assert.throws(() => buildImageValues(['bw-api'], SANDBOX_REF), /must be a JSON object/);
    const usage = spawnSync(process.execPath, [IMAGES_SCRIPT], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  });
});

describe('umbrella chart', () => {
  it('lints cleanly for dev, staging and prod with the hand-off merged in', () => {
    for (const env of ['dev', 'staging', 'prod']) {
      const r = spawnSync(
        'helm',
        ['lint', '--strict', CHART, '-f', path.join(CHART, `values-${env}.yaml`), '-f', GOOD.out],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 0, `${env}: ${r.stdout}${r.stderr}`);
    }
  });

  it('renders every long-running app and no per-run sandbox Deployment', () => {
    const docs = render('prod');
    const deployments = ofKind(docs, 'Deployment')
      .map((d) => at(d, 'metadata.name'))
      .sort();
    assert.deepEqual(deployments, [
      'api',
      'egress-gateway',
      'model-gateway',
      'sandbox-controller',
      'session-manager',
      'web',
      'worker',
    ]);
  });

  it('refuses to render without the image hand-off (fails closed, no tag fallback)', () => {
    const r = helmTemplate('dev', [], false);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /global\.images/);
  });

  it('schema rejects a tag, or a digest for another image, in global.images', () => {
    const tag = helmTemplate('dev', ['--set', `global.images.api=${REGISTRY}/bw-api:latest`]);
    assert.notEqual(tag.status, 0);
    assert.match(tag.stderr, /global\.images\.api/);
    const swapped = helmTemplate('dev', ['--set', `global.images.web=${IMAGES.api}`]);
    assert.notEqual(swapped.status, 0);
  });

  it('schema rejects a sandbox reference that is not a bw-sandbox digest', () => {
    const r = helmTemplate('dev', ['--set', `global.sandbox.imageRef=${REGISTRY}/bw-sandbox:1.0`]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /global\.sandbox\.imageRef/);
  });

  it('schema refuses a secret value in plain env and the sandbox pool for an app', () => {
    const secretEnv = helmTemplate('dev', ['--set', 'apps.api.env.DATABASE_PASSWORD=hunter2']);
    assert.notEqual(secretEnv.status, 0, 'a secret-looking env key is refused');
    const sandboxPool = helmTemplate('dev', ['--set', 'apps.api.pool=sandbox']);
    assert.notEqual(sandboxPool.status, 0, 'apps never run on the sandbox pool');
  });

  it('gives every Deployment probes, requests and limits, and the hardened pod and container settings', () => {
    for (const d of ofKind(render('prod'), 'Deployment')) {
      const name = String(at(d, 'metadata.name'));
      const pod = at(d, 'spec.template.spec');
      assert.equal(at(pod, 'securityContext.runAsNonRoot'), true, `${name} runs non-root`);
      assert.equal(
        at(pod, 'securityContext.seccompProfile.type'),
        'RuntimeDefault',
        `${name} seccomp`,
      );
      assert.ok(nodeSelectorOf(d)['blackwing.io/pool'], `${name} pins a pool`);
      for (const c of containers(d)) {
        assert.equal(
          at(c, 'securityContext.readOnlyRootFilesystem'),
          true,
          `${name} read-only rootfs`,
        );
        assert.equal(
          at(c, 'securityContext.allowPrivilegeEscalation'),
          false,
          `${name} no escalation`,
        );
        assert.deepEqual(
          at(c, 'securityContext.capabilities.drop'),
          ['ALL'],
          `${name} drops all caps`,
        );
        for (const probe of ['startupProbe', 'livenessProbe', 'readinessProbe']) {
          assert.ok(at(c, probe), `${name} has ${probe}`);
        }
        assert.ok(
          at(c, 'resources.requests.cpu') && at(c, 'resources.requests.memory'),
          `${name} requests`,
        );
        assert.ok(
          at(c, 'resources.limits.cpu') && at(c, 'resources.limits.memory'),
          `${name} limits`,
        );
      }
    }
  });

  it('probes hit /healthz and /readyz on the app port', () => {
    const docs = render('dev');
    const api = one(docs, 'Deployment', 'api');
    const c = containers(api)[0];
    assert.equal(at(c, 'livenessProbe.httpGet.path'), '/healthz');
    assert.equal(at(c, 'readinessProbe.httpGet.path'), '/readyz');
    assert.equal(at(c, 'readinessProbe.httpGet.port'), 'http');
  });

  it('keeps ServiceAccount tokens off except for sandbox-controller, which talks to the Kubernetes API', () => {
    const docs = render('prod');
    for (const sa of ofKind(docs, 'ServiceAccount')) {
      const name = String(at(sa, 'metadata.name'));
      assert.equal(
        sa.automountServiceAccountToken,
        name === 'sandbox-controller',
        `${name} token mount`,
      );
      const d = one(docs, 'Deployment', name);
      assert.equal(
        at(d, 'spec.template.spec.automountServiceAccountToken'),
        name === 'sandbox-controller',
      );
    }
  });

  it('pins every rendered image by digest and wires each Deployment to its hand-off entry', () => {
    const docs = render('prod');
    for (const app of CHART_APPS) {
      const d = one(docs, 'Deployment', app);
      assert.equal(containers(d)[0] && at(containers(d)[0], 'image'), IMAGES[app], `${app} digest`);
    }
    const rendered = helmTemplate('prod', []).stdout;
    for (const m of rendered.matchAll(/image: "?([^\s"]+)"?/g)) {
      assert.match(String(m[1]), /@sha256:[0-9a-f]{64}$/, `${m[1]} is digest-pinned`);
    }
  });

  it('passes the sandbox digest from IMAGE-012 to sandbox-controller as SBX_IMAGE_DIGEST', () => {
    const docs = render('dev');
    const cm = one(docs, 'ConfigMap', 'sandbox-controller-config');
    assert.equal(at(cm, 'data.SBX_IMAGE_DIGEST'), SANDBOX_REF);
    assert.equal(at(cm, 'data.SBX_RUNTIME_CLASS'), 'gvisor');
  });

  it('exposes the broker only on the cluster-internal api-broker Service and never routes it', () => {
    const docs = render('prod');
    const broker = one(docs, 'Service', 'api-broker');
    assert.equal(at(broker, 'spec.type'), 'ClusterIP');
    assert.equal(recordAt(broker, 'metadata.labels')['blackwing.io/exposure'], 'cluster-internal');
    assert.equal(at(one(docs, 'Service', 'api'), 'spec.type'), 'ClusterIP');
    assert.equal(ofKind(docs, 'Ingress').length, 0, 'the umbrella chart never renders an Ingress');
    assert.equal(
      ofKind(docs, 'IngressRoute').length,
      0,
      'the umbrella chart never renders an IngressRoute',
    );
    for (const svc of ofKind(docs, 'Service')) {
      assert.equal(
        at(svc, 'spec.type'),
        'ClusterIP',
        `${String(at(svc, 'metadata.name'))} is ClusterIP`,
      );
    }
  });

  it('reads secrets only through envFrom secretRef (never a literal) and renders no Secret object', () => {
    const docs = render('prod');
    assert.equal(ofKind(docs, 'Secret').length, 0);
    for (const d of [...ofKind(docs, 'Deployment'), ...ofKind(docs, 'Job')]) {
      for (const c of containers(d)) {
        for (const ref of /** @type {Doc[]} */ (at(c, 'envFrom') ?? [])) {
          if (at(ref, 'secretRef'))
            assert.equal(at(ref, 'secretRef.optional'), false, 'secret is required');
        }
        for (const env of /** @type {Doc[]} */ (at(c, 'env') ?? [])) {
          assert.equal(env.valueFrom, undefined, 'no literal secret env');
        }
      }
    }
  });

  it('runs the Drizzle migration as a pre-install and pre-upgrade hook with the api image', () => {
    const docs = render('dev');
    const job = one(docs, 'Job', 'db-migrate');
    assert.equal(recordAt(job, 'metadata.annotations')['helm.sh/hook'], 'pre-install,pre-upgrade');
    assert.equal(at(job, 'spec.template.spec.containers.0.image'), IMAGES.api);
    assert.equal(at(job, 'spec.template.spec.restartPolicy'), 'Never');
    assert.equal(at(job, 'spec.backoffLimit'), 2);
    const cm = one(docs, 'ConfigMap', 'db-migrate-config');
    assert.equal(recordAt(cm, 'metadata.annotations')['helm.sh/hook'], 'pre-install,pre-upgrade');
  });

  it('renders no migration Job when apps.api.migrations.enabled is false', () => {
    const docs = render('dev', ['--set', 'apps.api.migrations.enabled=false']);
    assert.equal(ofKind(docs, 'Job').length, 0);
  });

  it('turns HPAs and PDBs on per environment, and drops replicas when an HPA owns the scale', () => {
    const prod = render('prod');
    const hpa = one(prod, 'HorizontalPodAutoscaler', 'api');
    assert.equal(at(hpa, 'spec.minReplicas'), 2);
    assert.equal(
      at(one(prod, 'Deployment', 'api'), 'spec.replicas'),
      undefined,
      'HPA owns replicas',
    );
    assert.equal(at(one(prod, 'PodDisruptionBudget', 'api'), 'spec.minAvailable'), 1);
    const dev = render('dev');
    assert.equal(ofKind(dev, 'HorizontalPodAutoscaler').length, 0);
    assert.equal(ofKind(dev, 'PodDisruptionBudget').length, 0);
    assert.equal(at(one(dev, 'Deployment', 'api'), 'spec.replicas'), 1);
  });

  it('places apps on control-plane and the egress gateway on the egress pool, never the sandbox pool', () => {
    const docs = render('prod');
    for (const d of ofKind(docs, 'Deployment')) {
      const name = String(at(d, 'metadata.name'));
      assert.equal(
        nodeSelectorOf(d)['blackwing.io/pool'],
        name === 'egress-gateway' ? 'egress' : 'control-plane',
        `${name} pool`,
      );
    }
    assert.ok(!helmTemplate('prod').stdout.includes('blackwing.io/pool: sandbox'));
    assert.ok(
      !helmTemplate('prod').stdout.includes('tolerations'),
      'nothing tolerates sandbox nodes',
    );
  });

  it('exposes the egress tier on Services and the probes on the management port', () => {
    const docs = render('dev');
    const svc = one(docs, 'Service', 'egress-gateway');
    const names = /** @type {Doc[]} */ (at(svc, 'spec.ports') ?? []).map((p) => at(p, 'name'));
    assert.deepEqual(names, ['proxy', 'socks', 'dns-udp', 'dns-tcp', 'mgmt']);
    assert.equal(
      at(one(docs, 'Deployment', 'egress-gateway'), 'spec.template.spec.securityContext.runAsUser'),
      65532,
    );
  });

  it('adds OTel and Prometheus wiring to every pod template', () => {
    const docs = render('dev');
    for (const d of ofKind(docs, 'Deployment')) {
      const name = String(at(d, 'metadata.name'));
      const annotations = /** @type {Record<string, string>} */ (
        at(d, 'spec.template.metadata.annotations')
      );
      assert.equal(annotations['prometheus.io/scrape'], 'true', `${name} scrape`);
      assert.ok(annotations['prometheus.io/port'], `${name} metrics port`);
      const env = /** @type {Record<string, string>} */ (
        at(one(docs, 'ConfigMap', `${name}-config`), 'data')
      );
      assert.equal(env.OTEL_SERVICE_NAME, name);
      assert.equal(env.BW_ENVIRONMENT, 'dev');
    }
  });

  it('keeps the chart free of hardcoded image names: templates use the bw.image helper only', () => {
    for (const file of readdirSync(TEMPLATES)) {
      const text = readFileSync(path.join(TEMPLATES, file), 'utf8');
      assert.ok(!text.includes('ghcr.io'), `${file} hardcodes a registry`);
      for (const line of text.split('\n').filter((l) => /^\s*image:/.test(l))) {
        assert.match(line, /include "bw\.image"/, `${file}: ${line.trim()}`);
      }
    }
  });

  it('kubeconform accepts every rendered object', { skip: KUBECONFORM_SKIP }, () => {
    const rendered = helmTemplate('prod');
    assert.equal(rendered.status, 0, rendered.stderr);
    const r = spawnSync('kubeconform', ['-strict', '-summary', '-ignore-missing-schemas', '-'], {
      input: rendered.stdout,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});
