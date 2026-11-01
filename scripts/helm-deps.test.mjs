// Self-tests for the third-party dependencies chart (INFRA-010, infra/helm/bw-deps). Everything is rendered
// offline with `helm template`; nothing talks to a cluster or a registry. The real install on a kind or k3s
// cluster (every pod Ready, the SELECT on pg_extension, the Temporal sample workflow) is the integration half,
// listed in infra/helm/bw-deps/README.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAllDocuments } from 'yaml';

import { kubeconformSkipReason } from './test-fixtures.mjs';

const KUBECONFORM_SKIP = kubeconformSkipReason();
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS, '..');
const CHART = path.join(REPO, 'infra', 'helm', 'bw-deps');
const FILES = path.join(CHART, 'files');
const COMPOSE = path.join(REPO, 'infra', 'compose', 'docker-compose.dev.yml');

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
 * Runs helm template for the chart with the given overlay and extra arguments.
 * @param {string[]} [overlays] values files relative to the chart (default: values-dev.yaml)
 * @param {string[]} [extra] extra helm arguments, for example --set pairs
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function helmTemplate(overlays = ['values-dev.yaml'], extra = []) {
  const args = ['template', 'bw-deps', CHART, '-n', 'bw-system'];
  for (const overlay of overlays) args.push('-f', path.join(CHART, overlay));
  const r = spawnSync('helm', [...args, ...extra], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Renders the chart and parses every document.
 * @param {string[]} [overlays]
 * @param {string[]} [extra]
 * @returns {Doc[]}
 */
function render(overlays, extra) {
  const r = helmTemplate(overlays, extra);
  assert.equal(r.status, 0, r.stderr);
  return parseAllDocuments(r.stdout)
    .map((d) => /** @type {unknown} */ (d.toJS()) ?? null)
    .filter((d) => d !== null && typeof d === 'object')
    .map((d) => /** @type {Doc} */ (d));
}

/** The rendered openbao-config `config.hcl` text. @param {Doc[]} docs @returns {string} */
const openbaoHcl = (docs) => {
  const data = /** @type {Record<string, string>} */ (
    at(one(docs, 'ConfigMap', 'openbao-config'), 'data')
  );
  return String(data['config.hcl']);
};

/** @param {Doc[]} docs @param {string} kind @returns {Doc[]} */
const ofKind = (docs, kind) => docs.filter((d) => d.kind === kind);

/** @param {Doc[]} docs @param {string} kind @param {string} name @returns {Doc} */
function one(docs, kind, name) {
  const found = ofKind(docs, kind).find((d) => at(d, 'metadata.name') === name);
  assert.ok(found, `${kind}/${name} is rendered`);
  return found;
}

/** Every container of every Deployment, StatefulSet and Job. @param {Doc[]} docs @returns {Doc[]} */
function workloadContainers(docs) {
  return docs
    .filter((d) => ['Deployment', 'StatefulSet', 'Job'].includes(String(d.kind)))
    .flatMap((d) => /** @type {Doc[]} */ (at(d, 'spec.template.spec.containers') ?? []));
}

// KEY only as a whole word: BW_KEYCLOAK_DB names the Keycloak database, not a key.
const SECRET_LIKE = /PASSWORD|PWD|TOKEN|AUTH|SECRET|(^|_)KEY($|_)/;

describe('bw-deps chart: lint and render', () => {
  it('lints the dev and prod overlays', () => {
    for (const overlay of ['values-dev.yaml', 'values-prod.yaml']) {
      const extra =
        overlay === 'values-prod.yaml'
          ? ['--set', 'keycloak.publicUrl=https://id.example.test']
          : [];
      const r = spawnSync('helm', ['lint', CHART, '-f', path.join(CHART, overlay), ...extra], {
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, `${overlay}: ${r.stdout}${r.stderr}`);
    }
  });

  it('renders the dev overlay with the expected objects and no Secret', () => {
    const docs = render(['values-dev.yaml']);
    for (const name of [
      'postgres',
      'valkey',
      'neo4j',
      'minio',
      'openbao',
      'temporal',
      'keycloak',
      'interactsh',
    ]) {
      assert.ok(
        ofKind(docs, 'Service').some((d) => at(d, 'metadata.name') === name),
        `Service/${name}`,
      );
    }
    for (const name of ['prometheus', 'loki', 'tempo', 'grafana', 'otel-collector']) {
      assert.ok(
        ofKind(docs, 'Service').some((d) => at(d, 'metadata.name') === name),
        `obs Service/${name}`,
      );
    }
    // The chart never renders credentials: every Secret comes from the platform secret store.
    assert.deepEqual(
      ofKind(docs, 'Secret').map((d) => at(d, 'metadata.name')),
      [],
    );
  });

  it('renders every workload with a digest-pinned image', () => {
    const docs = render(['values-dev.yaml']);
    const containers = workloadContainers(docs);
    assert.ok(
      containers.length >= 14,
      `expected the full dependency set, got ${containers.length}`,
    );
    for (const c of containers) {
      assert.match(
        String(c.image),
        /@sha256:[0-9a-f]{64}$/,
        `${String(at(c, 'name'))} must be pinned by digest`,
      );
    }
  });

  it('pins every image to the digest the dev compose stack already uses', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const docs = render(['values-dev.yaml']);
    for (const c of workloadContainers(docs)) {
      const image = String(c.image);
      assert.ok(
        compose.includes(image),
        `${image} is not pinned identically in docker-compose.dev.yml`,
      );
    }
  });

  it('keeps every Service cluster-internal (ClusterIP only, no NodePort or LoadBalancer)', () => {
    const docs = render(['values-dev.yaml']);
    for (const svc of ofKind(docs, 'Service')) {
      assert.equal(
        at(svc, 'spec.type'),
        'ClusterIP',
        `${String(at(svc, 'metadata.name'))} must be ClusterIP`,
      );
    }
  });

  it('never sets a secret-like env var to a literal value', () => {
    const docs = render(['values-dev.yaml']);
    for (const c of workloadContainers(docs)) {
      for (const env of /** @type {Doc[]} */ (at(c, 'env') ?? [])) {
        const name = String(env.name);
        // Not secrets: a public URL that contains "KEY" and MinIO's metrics auth mode (not a credential).
        if (
          !SECRET_LIKE.test(name) ||
          name === 'BW_KEYCLOAK_PUBLIC_URL' ||
          name === 'MINIO_PROMETHEUS_AUTH_TYPE'
        ) {
          continue;
        }
        assert.ok(
          at(env, 'valueFrom.secretKeyRef.name'),
          `${name} in ${String(at(c, 'name'))} must come from a secretKeyRef`,
        );
        assert.equal(at(env, 'value'), undefined, `${name} must not carry a literal value`);
      }
    }
  });

  it('gives every long-running container a readiness probe and no service-account token', () => {
    const docs = render(['values-dev.yaml']);
    const long = docs.filter((d) => ['Deployment', 'StatefulSet'].includes(String(d.kind)));
    assert.ok(long.length > 0);
    for (const d of long) {
      const name = String(at(d, 'metadata.name'));
      assert.equal(
        at(d, 'spec.template.spec.automountServiceAccountToken'),
        false,
        `${name} token`,
      );
      for (const c of /** @type {Doc[]} */ (at(d, 'spec.template.spec.containers') ?? [])) {
        assert.ok(at(c, 'readinessProbe'), `${name}/${String(c.name)} needs a readiness probe`);
        assert.equal(
          at(c, 'securityContext.allowPrivilegeEscalation'),
          false,
          `${name}/${String(c.name)} must forbid privilege escalation`,
        );
      }
    }
  });

  it('keeps stateful data on PVCs that survive a StatefulSet delete or scale-down', () => {
    const docs = render(['values-dev.yaml']);
    for (const sts of ofKind(docs, 'StatefulSet')) {
      assert.equal(at(sts, 'spec.persistentVolumeClaimRetentionPolicy.whenDeleted'), 'Retain');
      assert.equal(at(sts, 'spec.persistentVolumeClaimRetentionPolicy.whenScaled'), 'Retain');
    }
  });

  it('runs the bootstrap steps as hooks, each failing the release when it fails', () => {
    const docs = render(['values-dev.yaml']);
    for (const name of [
      'postgres-provision',
      'neo4j-guard',
      'temporal-bootstrap',
      'openbao-mounts',
    ]) {
      const job = one(docs, 'Job', name);
      const annotations = /** @type {Record<string, string> | undefined} */ (
        at(job, 'metadata.annotations')
      );
      assert.match(String(annotations?.['helm.sh/hook']), /post-install/, name);
      assert.equal(at(job, 'spec.template.spec.restartPolicy'), 'Never', name);
    }
  });

  it('gates the observability profile with obs.enabled and keeps the data plane without it', () => {
    const docs = render(['values-dev.yaml'], ['--set', 'obs.enabled=false']);
    const names = ofKind(docs, 'Deployment').map((d) => at(d, 'metadata.name'));
    for (const obs of ['prometheus', 'loki', 'tempo', 'grafana', 'otel-collector']) {
      assert.ok(!names.includes(obs), `${obs} must not render when obs is disabled`);
    }
    assert.ok(names.includes('keycloak') && names.includes('temporal'), 'data plane still renders');
  });
});

describe('bw-deps chart: security and config contracts', () => {
  it('runs OpenBao with TLS on the listener in prod, and never plaintext', () => {
    const docs = render(
      ['values-prod.yaml'],
      ['--set', 'keycloak.publicUrl=https://id.example.test'],
    );
    const hcl = openbaoHcl(docs);
    assert.match(hcl, /tls_cert_file = "\/openbao\/tls\/tls\.crt"/);
    assert.doesNotMatch(hcl, /tls_disable/);
    assert.match(hcl, /storage "raft"/);
  });

  it('allows plaintext OpenBao only in dev', () => {
    const docs = render(['values-dev.yaml']);
    const hcl = openbaoHcl(docs);
    assert.match(hcl, /tls_disable = true/);
  });

  it('refuses to render OpenBao without a TLS Secret unless plaintext is allowed', () => {
    const r = helmTemplate(
      ['values-prod.yaml'],
      ['--set', 'keycloak.publicUrl=https://id.example.test', '--set', 'openbao.tls.secretName='],
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /openbao\.tls\.secretName is required/);
  });

  it('refuses plaintext OpenBao outside dev', () => {
    const r = helmTemplate(
      ['values-dev.yaml'],
      ['--set', 'global.environment=prod', '--set', 'keycloak.publicUrl=https://id.example.test'],
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /openbao\.allowPlaintext is only allowed with global\.environment=dev/);
  });

  it('refuses prod without the public Keycloak issuer', () => {
    const r = helmTemplate(['values-prod.yaml']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /keycloak\.publicUrl is required in prod/);
  });

  it('refuses a missing or unknown environment', () => {
    const missing = helmTemplate(['values-dev.yaml'], ['--set', 'global.environment=']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /global\.environment is required/);
    const unknown = helmTemplate(['values-dev.yaml'], ['--set', 'global.environment=sandbox']);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /must be dev, staging or prod/);
  });

  it('fails closed on an image reference that is not pinned by digest', () => {
    const r = helmTemplate(
      ['values-dev.yaml'],
      ['--set', 'images.postgres=pgvector/pgvector:0.8.1-pg16'],
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not pinned by a sha256 digest/);
  });

  it('fails when the grafana admin Secret is not named while obs is on', () => {
    const r = helmTemplate(['values-dev.yaml'], ['--set', 'obs.grafana.secretName=']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /obs\.grafana\.secretName is required/);
  });

  it('renders the interactsh DNS Service on both UDP and TCP 53', () => {
    const docs = render(['values-dev.yaml']);
    const ports = /** @type {Doc[]} */ (at(one(docs, 'Service', 'interactsh'), 'spec.ports') ?? []);
    const dns = ports
      .filter((p) => p.port === 53)
      .map((p) => p.protocol)
      .sort();
    assert.deepEqual(dns, ['TCP', 'UDP']);
  });

  it('enables the transit and KV v2 mounts through the openbao-mounts Job', () => {
    const script = readFileSync(path.join(FILES, 'openbao', 'enable-mounts.sh'), 'utf8');
    assert.match(script, /secrets enable -path=transit transit/);
    assert.match(script, /secrets enable -path=secret -version=2 kv/);
  });
});

describe('bw-deps chart: copied sources stay in sync with their owners', () => {
  it('ships the DB-001 role model byte-for-byte (packages/db/src/roles.sql)', () => {
    assert.equal(
      readFileSync(path.join(FILES, 'postgres', 'roles.sql'), 'utf8'),
      readFileSync(path.join(REPO, 'packages', 'db', 'src', 'roles.sql'), 'utf8'),
    );
  });

  it('ships the compose-proven configs unchanged', () => {
    /** @type {Array<[string, string]>} */
    const pairs = [
      ['neo4j/tenant-guard.cypher', 'infra/compose/neo4j/bootstrap/tenant-guard.cypher'],
      ['neo4j/tenant-indexes.cypher', 'infra/compose/neo4j/bootstrap/tenant-indexes.cypher'],
      ['neo4j/apoc.conf', 'infra/compose/neo4j/conf/apoc.conf'],
      ['keycloak/realm-blackwing.json', 'infra/keycloak/realm-blackwing.json'],
      ['temporal/bootstrap.sh', 'infra/compose/temporal/bootstrap.sh'],
      ['openbao/audit.hcl', 'infra/compose/openbao/config/audit.hcl'],
      ['obs/otel-collector.yaml', 'infra/compose/obs/otel-collector.yaml'],
      ['obs/prometheus.yml', 'infra/compose/obs/prometheus.yml'],
      ['obs/loki.yaml', 'infra/compose/obs/loki.yaml'],
      ['obs/tempo.yaml', 'infra/compose/obs/tempo.yaml'],
      [
        'obs/grafana/provisioning/datasources/datasources.yaml',
        'infra/compose/obs/grafana/provisioning/datasources/datasources.yaml',
      ],
      [
        'obs/grafana/provisioning/dashboards/dashboards.yaml',
        'infra/compose/obs/grafana/provisioning/dashboards/dashboards.yaml',
      ],
      [
        'obs/grafana/dashboards/blackwing-overview.json',
        'infra/compose/obs/grafana/dashboards/blackwing-overview.json',
      ],
    ];
    for (const [copy, source] of pairs) {
      assert.equal(
        readFileSync(path.join(FILES, copy), 'utf8'),
        readFileSync(path.join(REPO, source), 'utf8'),
        `${copy} drifted from ${source}`,
      );
    }
  });

  it('keeps the Postgres provisioning on the app role without BYPASSRLS', () => {
    const sql = readFileSync(path.join(FILES, 'postgres', 'provision.sh'), 'utf8');
    assert.match(sql, /LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT/);
    assert.match(sql, /GRANT bw_owner TO :"migrator_role"/);
  });
});

describe('bw-deps chart: shell scripts parse', () => {
  /** @type {Array<[string, string]>} */
  const scripts = [
    ['postgres/provision.sh', 'bash'],
    ['neo4j/install-guard.sh', 'bash'],
    ['openbao/enable-mounts.sh', 'sh'],
    ['temporal/bootstrap.sh', 'sh'],
  ];
  for (const [file, shell] of scripts) {
    it(`${file} is valid ${shell}`, () => {
      const r = spawnSync(shell, ['-n', path.join(FILES, file)], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    });
  }
});

describe('bw-deps chart: kubeconform', { skip: KUBECONFORM_SKIP }, () => {
  it('validates the rendered dev objects against the Kubernetes schemas', () => {
    const r = helmTemplate(['values-dev.yaml']);
    assert.equal(r.status, 0, r.stderr);
    const k = spawnSync(
      'kubeconform',
      ['-strict', '-summary', '-ignore-missing-schemas', '-kubernetes-version', '1.31.0'],
      { input: r.stdout, encoding: 'utf8' },
    );
    assert.equal(k.status, 0, `${k.stdout}${k.stderr}`);
  });
});
